import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as http2 from 'node:http2';
import { WebSocket } from 'ws';

/**
 * Requests aimed at a specific Accelerator entry point.
 *
 * The suite is given a vhost and the address of an entry point. It connects there
 * directly and sets `Host` (and the TLS SNI, when TLS is in play) to the vhost, so the
 * target is chosen per connection rather than by whatever DNS says about the vhost.
 * That is what lets one run register a tunnel through one entry point and assert
 * against another — and it means the vhost never has to resolve at all.
 */
export interface PinnedTarget {
    /** Address of the entry point. */
    endpoint: string;
    /** Vhost, used for the Host header and the TLS SNI. */
    vhost: string;
    /** Variant to force, as `vhost::VARIANT`. */
    variant: string;
    /** Whether to speak TLS. */
    tls: boolean;
}

export interface PinnedResponse {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
}

export interface PinnedRequestOptions {
    /** Connection pool to use, so a test can model a browser's limited parallelism. */
    agent?: http.Agent | https.Agent;
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
    /** Inactivity timeout, as Node measures it: reset by every byte that arrives. */
    timeoutMs?: number;
    /**
     * Total deadline for the whole exchange.
     *
     * `timeoutMs` cannot bound a response that goes quiet on purpose and then speaks
     * again — a long-poll or an idling SSE stream resets it with every chunk, and a
     * stream torn down mid-silence can leave the request neither erroring nor ending.
     */
    deadlineMs?: number;
    /**
     * Called as each chunk arrives, for assertions about streaming.
     *
     * Timestamp first, so a caller that only cares about timing takes one argument
     * and leaves nothing unused.
     */
    onChunk?: (at: number, chunk: Buffer) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A dev-tunnel variant requires `isDevelopment: true`, and a development variant can
 * never be put into traffic — the API rejects it outright. So it has to be selected
 * explicitly on every request, the same way the panel's "force variant" link does.
 */
function variantHeader(target: PinnedTarget): Record<string, string> {
    return { 'x-oa-variant': `${target.vhost}::${target.variant}` };
}

export function pinnedRequest(target: PinnedTarget, options: PinnedRequestOptions): Promise<PinnedResponse> {
    return new Promise((resolve, reject) => {
        const port = target.tls ? 443 : 80;
        const transport = target.tls ? https : http;
        const requestOptions = {
            host: target.endpoint,
            port,
            method: options.method ?? 'GET',
            path: options.path,
            headers: { host: target.vhost, ...variantHeader(target), ...options.headers },
            ...(options.agent ? { agent: options.agent } : {}),
            ...(target.tls
                ? {
                    servername: target.vhost,
                    // The certificate is issued for the vhost, which SNI and Host already
                    // name; we are only skipping the check against the entry point address.
                    rejectUnauthorized: false
                }
                : {})
        };

        // A connection torn down mid-response emits neither `end` nor, in some cases,
        // `error` — it just closes. Tracking settlement turns that into a failure with
        // a message instead of a promise nobody ever resolves.
        let settled = false;
        let received = 0;

        const succeed = (value: PinnedResponse): void => {
            settled = true;
            resolve(value);
        };

        const fail = (err: Error): void => {
            settled = true;
            reject(err);
        };

        const request = transport.request(requestOptions, (response) => {
            const chunks: Buffer[] = [];

            response.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
                received += chunk.length;
                options.onChunk?.(Date.now(), chunk);
            });

            response.on('end', () => succeed({
                statusCode: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks)
            }));
        });

        request.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
            request.destroy(new Error(`Request to ${options.path} timed out`));
        });

        if (options.deadlineMs !== undefined) {
            const deadline = setTimeout(() => {
                // Rejected directly rather than through request.destroy(): a connection
                // already torn down upstream swallows the destroy without emitting
                // anything, and the caller would wait for an event that never comes.
                fail(new Error(
                    `Request to ${options.path} did not complete within ${options.deadlineMs} ms`
                ));
                request.destroy();
            }, options.deadlineMs);

            request.once('close', () => clearTimeout(deadline));
        }

        request.on('error', fail);
        request.on('close', () => {
            if (!settled) {
                fail(new Error(
                    `Connection to ${options.path} closed before the response completed `
                    + `(${received} byte(s) received)`
                ));
            }
        });

        if (options.body !== undefined) {
            request.write(options.body);
        }

        request.end();
    });
}

/** Open a browser-style WebSocket through the same pinned path. */
export function pinnedWebSocket(target: PinnedTarget, path: string, headers?: Record<string, string>): WebSocket {
    const scheme = target.tls ? 'wss' : 'ws';
    const port = target.tls ? 443 : 80;

    return new WebSocket(`${scheme}://${target.endpoint}:${port}${path}`, {
        headers: { host: target.vhost, ...variantHeader(target), ...headers },
        ...(target.tls ? { servername: target.vhost, rejectUnauthorized: false } : {})
    } as never);
}

/**
 * Send bytes that no HTTP client would agree to produce.
 *
 * Node's client normalises or refuses a request declaring both `Content-Length` and
 * `Transfer-Encoding`, which is the request shape worth asking Accelerator about. This
 * writes the request line, headers and body verbatim and returns whatever comes back,
 * head included, without parsing it.
 */
export function pinnedRawRequest(target: PinnedTarget, rawRequest: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    return new Promise((resolve, reject) => {
        const port = target.tls ? 443 : 80;
        const socket = target.tls
            ? tls.connect({ host: target.endpoint, port, servername: target.vhost, rejectUnauthorized: false })
            : net.connect({ host: target.endpoint, port });

        const chunks: Buffer[] = [];
        const finish = (): void => resolve(Buffer.concat(chunks).toString('latin1'));

        socket.setTimeout(timeoutMs, () => {
            // A response that never ends is itself an answer here, so whatever arrived
            // before the timeout is the result rather than a failure.
            socket.destroy();
            finish();
        });
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        socket.on('end', finish);
        socket.on('close', finish);
        socket.on('error', (err) => (chunks.length > 0 ? finish() : reject(err)));
        socket.on(target.tls ? 'secureConnect' : 'connect', () => socket.write(rawRequest));
    });
}

/**
 * Open one HTTP/2 session to the entry point.
 *
 * HTTP/2 needs ALPN, so this only works where the entry point terminates TLS with a
 * certificate for the vhost. Cleartext h2c is not accepted on port 80.
 */
export function pinnedHttp2Session(target: PinnedTarget): http2.ClientHttp2Session {
    return http2.connect(`https://${target.endpoint}:443`, {
        servername: target.vhost,
        rejectUnauthorized: false
    });
}

/** One request on an existing HTTP/2 session, with the variant forced as everywhere else. */
export function pinnedHttp2Request(
    session: http2.ClientHttp2Session,
    target: PinnedTarget,
    path: string
): Promise<PinnedResponse> {
    return new Promise((resolve, reject) => {
        const stream = session.request({
            ':method': 'GET',
            ':path': path,
            ':authority': target.vhost,
            ...variantHeader(target)
        });

        const chunks: Buffer[] = [];
        let statusCode = 0;
        let headers: Record<string, string | string[] | undefined> = {};

        stream.on('response', (received) => {
            statusCode = Number(received[':status'] ?? 0);
            headers = received as Record<string, string | string[] | undefined>;
        });
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => resolve({ statusCode, headers, body: Buffer.concat(chunks) }));
        stream.on('error', reject);
        stream.end();
    });
}
