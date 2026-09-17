import * as http from 'node:http';
import * as zlib from 'node:zlib';
import { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { deterministicPayload, sha256 } from './payload.js';

export const LARGE_BODY_SEED = 1337;
export const LARGE_BODY_SIZE = 512 * 1024;
export const SSE_EVENT_COUNT = 5;
export const SSE_EVENT_GAP_MS = 120;

/** Body used by the compression routes; long and repetitive so it compresses well. */
export const COMPRESSIBLE_BODY = 'dev tunnel compression probe. '.repeat(400);

/** ETag `/etag` serves its body under. */
const ETAG_VALUE = 'fixture-etag-v1';

/** Body `/etag` serves. */
export const ETAG_BODY = 'etag-body';

/**
 * Serve a body under a fixed encoding, whatever the request asked for.
 *
 * The point is to control the *application's* half of the negotiation independently of
 * the browser's, because Accelerator rewrites Accept-Encoding on the way upstream — the
 * local app never sees what the browser sent.
 */
function serveEncoded(res: http.ServerResponse, encoding: 'gzip' | 'br' | 'identity', body: string): void {
    const headers: http.OutgoingHttpHeaders = { 'content-type': 'text/plain' };
    let payload: Buffer;

    switch (encoding) {
        case 'gzip':
            payload = zlib.gzipSync(body);
            headers['content-encoding'] = 'gzip';
            break;
        case 'br':
            payload = zlib.brotliCompressSync(body);
            headers['content-encoding'] = 'br';
            break;
        default:
            payload = Buffer.from(body);
    }

    headers['content-length'] = payload.length;
    res.writeHead(200, headers);
    res.end(payload);
}

/**
 * The application on the developer's side of the tunnel.
 *
 * Behaviour is selected by path rather than by a flag, so one instance serves the whole
 * suite and the tests stay independent of each other.
 */
export interface FixtureServer {
    port: number;
    /** TCP connections accepted so far — the tunnel forces one per request. */
    connectionCount: () => number;
    close: () => Promise<void>;
}

/** How many assets the waterfall page references. */
export const WATERFALL_ASSET_COUNT = 24;

/** Deterministic size for asset `n`, spread across a realistic range. */
export function waterfallAssetSize(index: number): number {
    return 1024 + (index * 3571) % 47_000;
}

function notFound(res: http.ServerResponse): void {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
}

export async function startFixtureServer(): Promise<FixtureServer> {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');

        switch (true) {
            case url.pathname === '/static/small': {
                const body = 'hello from the tunnel';

                res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) });
                res.end(body);

                return;
            }
            case url.pathname === '/static/large': {
                const body = deterministicPayload(LARGE_BODY_SEED, LARGE_BODY_SIZE);

                res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
                res.end(body);

                return;
            }
            case url.pathname === '/chunked': {
                // No content-length and several writes, so Node uses chunked encoding.
                // This is the shape that a double-framing bug corrupts.
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.write('first-');
                res.write('second-');
                res.write('third');
                res.end();

                return;
            }
            case url.pathname === '/sse': {
                res.writeHead(200, {
                    'content-type': 'text/event-stream',
                    'cache-control': 'no-cache'
                });

                let sent = 0;
                const timer = setInterval(() => {
                    sent += 1;
                    res.write(`data: event-${sent}\n\n`);

                    if (sent >= SSE_EVENT_COUNT) {
                        clearInterval(timer);
                        res.end();
                    }
                }, SSE_EVENT_GAP_MS);

                res.on('close', () => clearInterval(timer));

                return;
            }
            case url.pathname === '/slow': {
                const delay = Number(url.searchParams.get('ms') ?? '1000');

                setTimeout(() => {
                    res.writeHead(200, { 'content-type': 'text/plain' });
                    res.end('slow');
                }, delay);

                return;
            }
            case url.pathname === '/headers/multi-cookie': {
                res.writeHead(200, {
                    'content-type': 'text/plain',
                    'set-cookie': ['a=1; Path=/', 'b=2; Path=/'],
                    'X-Mixed-Case': 'preserved'
                });
                res.end('cookies');

                return;
            }
            case url.pathname === '/headers/malformed': {
                // Written straight to the socket, because Node's own writeHead would
                // reject this. The proxy must survive it — the assertion that matters
                // is that the *next* request still works.
                const socket = res.socket;

                if (socket) {
                    socket.write('HTTP/1.1 200 OK\r\nBad Header Name: x\r\nContent-Length: 2\r\n\r\nok');
                    socket.end();
                }

                return;
            }
            case url.pathname === '/close-mid-response': {
                res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' });
                res.write('partial');
                res.socket?.destroy();

                return;
            }
            case url.pathname.startsWith('/status/'): {
                const code = Number(url.pathname.slice('/status/'.length));

                res.writeHead(Number.isInteger(code) ? code : 500);
                res.end();

                return;
            }
            case url.pathname === '/echo': {
                const chunks: Buffer[] = [];

                req.on('data', (chunk: Buffer) => chunks.push(chunk));
                req.on('end', () => {
                    const received = Buffer.concat(chunks);
                    // The digest is what makes this a body test rather than a length
                    // test: a body that is re-framed, truncated or re-encoded on the
                    // way through keeps its byte count far more often than its hash.
                    const body = JSON.stringify({
                        bytes: received.length,
                        method: req.method,
                        sha256: sha256(received),
                        contentType: req.headers['content-type'] ?? null
                    });

                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(body);
                });

                return;
            }
            case url.pathname === '/compress/gzip': {
                serveEncoded(res, 'gzip', COMPRESSIBLE_BODY);

                return;
            }
            case url.pathname === '/compress/brotli': {
                serveEncoded(res, 'br', COMPRESSIBLE_BODY);

                return;
            }
            case url.pathname === '/compress/identity': {
                // An application that ignores Accept-Encoding entirely.
                serveEncoded(res, 'identity', COMPRESSIBLE_BODY);

                return;
            }
            case url.pathname === '/compress/negotiated': {
                // What a well-behaved application does: pick from what it was offered.
                const offered = (req.headers['accept-encoding'] ?? '').toString();
                const picked = offered.includes('br') ? 'br' : offered.includes('gzip') ? 'gzip' : 'identity';

                res.setHeader('x-fixture-offered', offered || '(none)');
                serveEncoded(res, picked, COMPRESSIBLE_BODY);

                return;
            }
            case url.pathname === '/compress/seen-accept-encoding': {
                // Reports what actually reached the application, which is not what the
                // browser sent — Accelerator replaces it on the way upstream.
                const body = JSON.stringify({ acceptEncoding: req.headers['accept-encoding'] ?? null });

                res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
                res.end(body);

                return;
            }
            case url.pathname === '/compress/gzip-large': {
                // Binary integrity of a compressed body: the corruption that motivated
                // this suite would be invisible on a short, text-only payload.
                const payload = zlib.gzipSync(deterministicPayload(LARGE_BODY_SEED, LARGE_BODY_SIZE));

                res.writeHead(200, {
                    'content-type': 'application/octet-stream',
                    'content-encoding': 'gzip',
                    'content-length': payload.length
                });
                res.end(payload);

                return;
            }
            case url.pathname === '/waterfall/index.html': {
                const links: string[] = [];

                for (let index = 0; index < WATERFALL_ASSET_COUNT; index++) {
                    links.push(`<script src="/waterfall/asset/${index}"></script>`);
                }

                const body = `<!doctype html><html><head>\n${links.join('\n')}\n</head><body>ok</body></html>`;

                res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) });
                res.end(body);

                return;
            }
            case url.pathname.startsWith('/waterfall/asset/'): {
                const index = Number(url.pathname.slice('/waterfall/asset/'.length));

                if (!Number.isInteger(index) || index < 0 || index >= WATERFALL_ASSET_COUNT) {
                    notFound(res);

                    return;
                }

                const body = deterministicPayload(index + 1, waterfallAssetSize(index));

                res.writeHead(200, {
                    'content-type': 'application/javascript',
                    'content-length': body.length
                });
                res.end(body);

                return;
            }
            case url.pathname === '/response/cl-and-te': {
                // Content-Length and Transfer-Encoding declared at once, which is
                // ambiguous by spec and the shape request smuggling is built on.
                // Written straight to the socket because Node refuses to emit it.
                const socket = res.socket;

                if (socket) {
                    socket.write(
                        'HTTP/1.1 200 OK\r\n'
                        + 'Content-Type: text/plain\r\n'
                        + 'Content-Length: 5\r\n'
                        + 'Transfer-Encoding: chunked\r\n'
                        + '\r\n'
                        + '5\r\nhello\r\n0\r\n\r\n'
                    );
                    socket.end();
                }

                return;
            }
            case url.pathname === '/long-poll': {
                // Holds the request open sending nothing, then answers — a comet or
                // socket.io polling endpoint, and exactly what an idle timeout kills.
                const holdMs = Number(url.searchParams.get('ms') ?? '5000');
                const timer = setTimeout(() => {
                    res.writeHead(200, { 'content-type': 'text/plain' });
                    res.end('long-poll-done');
                }, holdMs);

                res.on('close', () => clearTimeout(timer));

                return;
            }
            case url.pathname === '/sse-idle': {
                // One event, a long silence, one more. The silence is the subject: an
                // SSE stream quiet for a while between events.
                const gapMs = Number(url.searchParams.get('gap') ?? '5000');

                res.writeHead(200, {
                    'content-type': 'text/event-stream',
                    'cache-control': 'no-cache'
                });
                res.write('data: first\n\n');

                const timer = setTimeout(() => {
                    res.write('data: second\n\n');
                    res.end();
                }, gapMs);

                res.on('close', () => clearTimeout(timer));

                return;
            }
            case url.pathname === '/etag': {
                // A validator the browser should receive untouched. Revalidation itself
                // is not exercised: Accelerator strips If-None-Match on the way upstream,
                // so an application behind a tunnel never sees a conditional request.
                res.writeHead(200, {
                    'etag': `"${ETAG_VALUE}"`,
                    'content-type': 'text/plain',
                    'content-length': Buffer.byteLength(ETAG_BODY)
                });
                res.end(ETAG_BODY);

                return;
            }
            case url.pathname === '/headers/echo': {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(req.headers));

                return;
            }
            default:
                notFound(res);
        }
    });

    function echoConnection(socket: WebSocket, request: http.IncomingMessage): void {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;

        if (path === '/ws/headers') {
            // Answers with the handshake headers as the local server received them, so a
            // test can see which of the browser's survived being replayed through the
            // tunnel. On request rather than on connection: a frame sent before the
            // caller has a listener attached is simply lost, and that race is the test's
            // to avoid, not the tunnel's.
            socket.on('message', () => socket.send(JSON.stringify(request.headers)));

            return;
        }

        // `/ws/idle` says nothing until the client speaks, which is how an idle HMR
        // socket behaves; every other path behaves the same way.
        socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
    }

    const wss = new WebSocketServer({ noServer: true });
    wss.on('connection', echoConnection);

    server.on('upgrade', (request, socket, head) => {
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    });

    // Counted so a test can see how many TCP connections the tunnel actually opens
    // against the local application — the proxy appends `Connection: close` to every
    // request it forwards, so a page of assets is a page of connections.
    let connections = 0;

    server.on('connection', () => {
        connections += 1;
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    return {
        port: (server.address() as AddressInfo).port,
        connectionCount: () => connections,
        close: () => new Promise<void>((resolve) => {
            for (const client of wss.clients) {
                client.terminate();
            }

            wss.close();
            // server.close() waits for open connections to finish, and a failed test
            // can easily leave one behind — which turns a teardown into a hang.
            server.closeAllConnections();
            server.close(() => resolve());
        })
    };
}
