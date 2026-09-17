import * as zlib from 'node:zlib';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { readE2eConfig, MISSING_CONFIG_MESSAGE } from './config.js';
import {
    startFixtureServer,
    FixtureServer,
    COMPRESSIBLE_BODY,
    ETAG_BODY,
    LARGE_BODY_SEED,
    LARGE_BODY_SIZE,
    SSE_EVENT_COUNT
} from './fixture/server.js';
import { deterministicPayload, sha256 } from './fixture/payload.js';
import { pinnedRawRequest, pinnedRequest, pinnedWebSocket, PinnedTarget } from './harness/pinned.js';
// The real client, not a stand-in. That is the point of this suite living here: the
// tunnel side of every assertion below is the code we ship.
import { READY_TIMEOUT_MS, startSession, targetFor, unique, waitForTunnel } from './harness/session.js';
import type { Tunnel } from '../../src/types.js';

const config = readE2eConfig();
const describeE2e = config ? describe : describe.skip;

if (!config) {
    console.warn(MISSING_CONFIG_MESSAGE);
}

// describe.skip still evaluates its body to collect test names, so the suite needs
// something to read even when it is going to be skipped.
const cfg = config ?? {
    vhost: 'unconfigured.invalid',
    variant: 'NONE',
    token: '',
    primaryEndpoint: 'unconfigured.invalid',
    secondaryEndpoint: undefined,
    tls: true
};

const TEST_TIMEOUT_MS = 60_000;

describeE2e('dev tunnel end to end', () => {
    const primary: PinnedTarget = targetFor(cfg);

    let fixture: FixtureServer;
    let tunnel: Tunnel;

    beforeAll(async () => {
        fixture = await startFixtureServer();
        tunnel = await startSession(cfg, fixture.port);

        await waitForTunnel(primary);
    }, READY_TIMEOUT_MS * 2);

    afterAll(async () => {
        await tunnel?.stop();
        await fixture?.close();
    });

    describe('response integrity', () => {
        it('serves a small static response unchanged', async () => {
            const response = await pinnedRequest(primary, { path: unique('/static/small') });

            expect(response.statusCode).toBe(200);
            expect(response.body.toString()).toBe('hello from the tunnel');
        }, TEST_TIMEOUT_MS);

        it('does not corrupt a chunked response', async () => {
            // Forwarding transfer-encoding into writeHead makes Node re-frame bytes the
            // client already chunk-framed, so the framing ends up inside the body. Every
            // Express/Fastify/Next dev server emits chunked for a dynamic response.
            const response = await pinnedRequest(primary, { path: unique('/chunked') });

            expect(response.statusCode).toBe(200);
            expect(response.body.toString()).toBe('first-second-third');
        }, TEST_TIMEOUT_MS);

        it('reassembles a large body byte for byte', async () => {
            const response = await pinnedRequest(primary, { path: unique('/static/large') });

            expect(response.statusCode).toBe(200);
            expect(response.body.length).toBe(LARGE_BODY_SIZE);
            expect(sha256(response.body)).toBe(sha256(deterministicPayload(LARGE_BODY_SEED, LARGE_BODY_SIZE)));
        }, TEST_TIMEOUT_MS);

        it('carries a large request body to the local app intact', async () => {
            const body = deterministicPayload(4242, 256 * 1024);
            const response = await pinnedRequest(primary, {
                method: 'POST',
                path: unique('/echo'),
                headers: { 'content-type': 'application/octet-stream' },
                body
            });

            expect(response.statusCode).toBe(200);
            expect(JSON.parse(response.body.toString())).toEqual({
                bytes: body.length,
                method: 'POST',
                sha256: sha256(body),
                contentType: 'application/octet-stream'
            });
        }, TEST_TIMEOUT_MS);

        it('gives the browser the ETag the local application set', async () => {
            const response = await pinnedRequest(primary, { path: unique('/etag') });

            expect(response.statusCode).toBe(200);
            expect(response.body.toString()).toBe(ETAG_BODY);
            expect(response.headers.etag).toBeDefined();
        }, TEST_TIMEOUT_MS);

        it('preserves duplicate Set-Cookie headers as separate headers', async () => {
            const response = await pinnedRequest(primary, { path: unique('/headers/multi-cookie') });

            expect(response.headers['set-cookie']).toEqual(expect.arrayContaining(['a=1; Path=/', 'b=2; Path=/']));
        }, TEST_TIMEOUT_MS);

        it('never leaks the routing cookies to the browser', async () => {
            const response = await pinnedRequest(primary, { path: unique('/static/small') });
            const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);

            expect(cookies.some((cookie) => cookie.startsWith('AWSALB'))).toBe(false);
        }, TEST_TIMEOUT_MS);

        it('does not echo the local application hop-by-hop headers', async () => {
            // `Connection: close` is added to the request the tunnel makes, and the
            // local app answers in kind; echoing it back would tear down the keep-alive
            // in front of the tunnel on every request.
            //
            // Note that `Transfer-Encoding: chunked` *is* expected here and is not a
            // leak: the body arrives decoded and carries no Content-Length, so Node
            // frames it for this hop. What matters is that the content is intact,
            // which the chunked case above asserts.
            const response = await pinnedRequest(primary, { path: unique('/chunked') });

            expect(response.statusCode).toBe(200);
            expect(response.headers.connection).not.toBe('close');
            expect(response.headers['keep-alive']).toBeUndefined();
        }, TEST_TIMEOUT_MS);

        it('streams SSE events as they are produced rather than buffering them', async () => {
            // A correct body with the wrong timing means something buffered the whole
            // response, which is exactly what SSE is here to detect.
            const arrivals: number[] = [];

            const response = await pinnedRequest(primary, {
                path: unique('/sse'),
                onChunk: (at) => arrivals.push(at)
            });

            expect(response.statusCode).toBe(200);
            expect(response.body.toString()).toContain(`data: event-${SSE_EVENT_COUNT}`);
            expect(arrivals.length).toBeGreaterThan(1);

            const first = arrivals[0] ?? 0;
            const last = arrivals[arrivals.length - 1] ?? 0;

            expect(last - first).toBeGreaterThan(100);
        }, TEST_TIMEOUT_MS);
    });

    describe('request headers', () => {
        async function headersSeenByApp(headers?: Record<string, string>): Promise<Record<string, string>> {
            const response = await pinnedRequest(primary, { path: unique('/headers/echo'), headers });

            expect(response.statusCode).toBe(200);

            return JSON.parse(response.body.toString()) as Record<string, string>;
        }

        it('gives the local application the vhost as its Host', async () => {
            // The ALB overwrites Host with the proxy's internal address, and the proxy
            // restores it from x-acc-dev-tunnel-host before forwarding. Without that a
            // dev server refuses the request as an unknown host, which is the failure
            // the Vite and webpack plugins exist to configure around.
            const seen = await headersSeenByApp();

            expect(seen.host).toBe(cfg.vhost);
        }, TEST_TIMEOUT_MS);

        it('never hands the local application the tunnel credentials', async () => {
            // The one that would matter: x-tunnel-token authenticates the tunnel, and the
            // local application is the least trusted thing in the path. Asserted on its
            // own so it is never masked by a lesser header leaking first.
            const seen = await headersSeenByApp();

            expect(seen['x-tunnel-token']).toBeUndefined();
        }, TEST_TIMEOUT_MS);

        it('does not leak the tunnel\'s routing headers to the local application', async () => {
            // Plumbing between EdgeServer, the proxy and the client. An application that
            // saw these could route on them, and they are not a contract.
            const seen = await headersSeenByApp();

            expect(seen['x-acc-dev-tunnel-host']).toBeUndefined();
            expect(seen['x-tunnel-request-id']).toBeUndefined();
            expect(seen['x-tunnel-pooled']).toBeUndefined();
        }, TEST_TIMEOUT_MS);

        it('passes a request header through untouched', async () => {
            const seen = await headersSeenByApp({ 'x-fixture-probe': 'carried-through' });

            expect(seen['x-fixture-probe']).toBe('carried-through');
        }, TEST_TIMEOUT_MS);

        it('tells the local application who the client is', async () => {
            // The tunnel knows the caller's address — it travels in open_data and the CLI
            // logs it — but an application behind a proxy reads it off a header.
            const seen = await headersSeenByApp();

            expect(seen['x-forwarded-for']).toBeDefined();
        }, TEST_TIMEOUT_MS);
    });

    describe('request bodies', () => {
        // The large-body case under response integrity sends no content-length, so Node
        // frames that one as chunked. These cover the other shapes a real client sends.

        // JSON gets a case of its own because the content type, not the method or the
        // framing, is what once broke it: the proxy accepted every content type with a
        // '*' parser, which does not displace Fastify's built-in application/json and
        // text/plain parsers, so those two were read before anything could be piped and
        // the request timed out. Bodies under any other content type never were.
        // Both content types Fastify parses out of the box, and both were drained before
        // anything could be piped. Covering only one would leave the other's regression
        // invisible, which is the whole shape of the defect these exist for.
        it.each([
            ['application/json', JSON.stringify({ hello: 'tunnel', nested: { list: [1, 2, 3] } })],
            ['text/plain', 'a plain body the proxy must not read on its own']
        ])('carries a length-framed %s body byte-exact', async (contentType, body) => {
            const sent = body as string;
            const response = await pinnedRequest(primary, {
                method: 'POST',
                path: unique('/echo'),
                headers: {
                    'content-type': contentType as string,
                    // Declared explicitly, so this request is length-framed rather than
                    // chunked — the shape a browser fetch() actually sends.
                    'content-length': String(Buffer.byteLength(sent))
                },
                body: sent
            });

            expect(response.statusCode).toBe(200);
            expect(JSON.parse(response.body.toString())).toEqual({
                bytes: Buffer.byteLength(sent),
                method: 'POST',
                sha256: sha256(sent),
                contentType
            });
        }, TEST_TIMEOUT_MS);

        it('carries a multipart/form-data upload byte-exact, boundary included', async () => {
            // The commonest irregular body on the web, and the next content type in line
            // after the one that was being dropped. The boundary lives in the content
            // type, so losing that parameter makes the body unparseable even intact.
            const boundary = '----AccDevTunnelFixtureBoundary7331';
            const file = deterministicPayload(2026, 48 * 1024);
            const body = Buffer.concat([
                Buffer.from(
                    `--${boundary}\r\n`
                    + 'Content-Disposition: form-data; name="field"\r\n\r\n'
                    + 'value\r\n'
                    + `--${boundary}\r\n`
                    + 'Content-Disposition: form-data; name="file"; filename="payload.bin"\r\n'
                    + 'Content-Type: application/octet-stream\r\n\r\n'
                ),
                file,
                Buffer.from(`\r\n--${boundary}--\r\n`)
            ]);

            const response = await pinnedRequest(primary, {
                method: 'POST',
                path: unique('/echo'),
                headers: {
                    'content-type': `multipart/form-data; boundary=${boundary}`,
                    'content-length': String(body.length)
                },
                body
            });

            expect(response.statusCode).toBe(200);
            expect(JSON.parse(response.body.toString())).toEqual({
                bytes: body.length,
                method: 'POST',
                sha256: sha256(body),
                contentType: `multipart/form-data; boundary=${boundary}`
            });
        }, TEST_TIMEOUT_MS);

        it('carries a request declaring both Content-Length and Transfer-Encoding', async () => {
            // Ambiguous by spec and the basis of request smuggling, so the only wrong
            // answer is to forward it as if it were unambiguous. Accelerator refusing it
            // outright is a fine answer; so is one framing winning consistently. Node's
            // own client will not emit this, hence the raw socket.
            const lines = [
                `POST ${unique('/echo')} HTTP/1.1`,
                `Host: ${cfg.vhost}`,
                `x-oa-variant: ${cfg.vhost}::${cfg.variant}`,
                'Content-Type: application/octet-stream',
                'Content-Length: 5',
                'Transfer-Encoding: chunked',
                'Connection: close',
                '',
                '5\r\nhello\r\n0\r\n',
                ''
            ];
            const raw = await pinnedRawRequest(primary, lines.join('\r\n'), 20_000);

            const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(raw)?.[1] ?? 0);

            // Rejected, or carried under exactly one framing — never two responses, and
            // never nothing at all.
            expect(status).toBeGreaterThan(0);
            expect([400, 411, 501, 502, 200]).toContain(status);
            expect((raw.match(/^HTTP\/1\.[01] /gm) ?? []).length).toBe(1);
        }, TEST_TIMEOUT_MS);

        it('carries a PUT body and method through unchanged', async () => {
            // PUT rather than POST because the method travels in the request line the
            // proxy rewrites; a method it does not expect must not be normalised away.
            const body = deterministicPayload(7331, 64 * 1024);
            const response = await pinnedRequest(primary, {
                method: 'PUT',
                path: unique('/echo'),
                headers: {
                    'content-type': 'application/octet-stream',
                    'content-length': String(body.length)
                },
                body
            });

            expect(response.statusCode).toBe(200);
            expect(JSON.parse(response.body.toString())).toEqual({
                bytes: body.length,
                method: 'PUT',
                sha256: sha256(body),
                contentType: 'application/octet-stream'
            });
        }, TEST_TIMEOUT_MS);

        it('completes a POST that carries no body', async () => {
            // A zero-length body is where a proxy that waits for bytes that never come
            // hangs instead of answering. Deliberately not application/json: that content
            // type has a defect of its own (see the JSON case above), and a test that
            // tripped over both would say nothing about either.
            const response = await pinnedRequest(primary, {
                method: 'POST',
                path: unique('/echo'),
                headers: { 'content-type': 'application/octet-stream', 'content-length': '0' },
                body: ''
            });

            expect(response.statusCode).toBe(200);
            expect(JSON.parse(response.body.toString())).toEqual({
                bytes: 0,
                method: 'POST',
                sha256: sha256(''),
                contentType: 'application/octet-stream'
            });
        }, TEST_TIMEOUT_MS);

        it('keeps concurrent POST bodies apart', async () => {
            // Data connections are pooled and reused, so a body written to the wrong
            // one would surface here and nowhere else: each response has to carry the
            // digest of its own request, not of whichever request shared the slot.
            const bodies = [0, 1, 2, 3, 4, 5].map((index) => deterministicPayload(index + 500, 8_192 + index * 1_024));

            const responses = await Promise.all(bodies.map((body) => pinnedRequest(primary, {
                method: 'POST',
                path: unique('/echo'),
                headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length) },
                body
            })));

            responses.forEach((response, index) => {
                const body = bodies[index] as Buffer;

                expect(response.statusCode).toBe(200);
                expect(JSON.parse(response.body.toString())).toEqual({
                    bytes: body.length,
                    method: 'POST',
                    sha256: sha256(body),
                    contentType: 'application/octet-stream'
                });
            });
        }, TEST_TIMEOUT_MS);
    });

    describe('response framing', () => {
        it('survives a response declaring both Content-Length and Transfer-Encoding', async () => {
            // The response counterpart of the ambiguous request above. As with the
            // malformed header case, what matters most is the request after it: a throw
            // while parsing this head would take down every tunnel on the pod.
            const ambiguous = await pinnedRequest(primary, { path: unique('/response/cl-and-te') });

            expect([200, 502]).toContain(ambiguous.statusCode);

            if (ambiguous.statusCode === 200) {
                // Whichever framing won, the body may not carry the chunk markers.
                expect(ambiguous.body.toString()).not.toContain('\r\n0\r\n');
            }

            const next = await pinnedRequest(primary, { path: unique('/static/small') });

            expect(next.statusCode).toBe(200);
        }, TEST_TIMEOUT_MS);
    });

    describe('compression', () => {
        /**
         * Decode a response body according to what it says it is.
         *
         * Node's http client does not decompress, which is what we want here: the test
         * has to see the encoding that actually arrived, not a convenience.
         */
        function decode(response: { headers: Record<string, string | string[] | undefined>; body: Buffer; }): string {
            const encoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();

            switch (encoding) {
                case 'gzip':
                    return zlib.gunzipSync(response.body).toString();
                case 'br':
                    return zlib.brotliDecompressSync(response.body).toString();
                case 'deflate':
                    return zlib.inflateSync(response.body).toString();
                case 'identity':
                    return response.body.toString();
                default:
                    throw new Error(`Unexpected content-encoding: ${encoding}`);
            }
        }

        function encodingOf(response: { headers: Record<string, string | string[] | undefined>; }): string {
            return String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
        }

        it('reports which Accept-Encoding actually reaches the application', async () => {
            // Not an assertion about the browser's request: Accelerator replaces
            // Accept-Encoding on the way upstream, so the application negotiates with
            // Accelerator rather than with the browser. Pinned here because anything
            // else in this block only makes sense once that is understood.
            const response = await pinnedRequest(primary, {
                path: unique('/compress/seen-accept-encoding'),
                headers: { 'accept-encoding': 'br' }
            });

            expect(response.statusCode).toBe(200);
            expect(JSON.parse(response.body.toString()).acceptEncoding).toBe('br, gzip');
        }, TEST_TIMEOUT_MS);

        it('delivers a gzip response to a client that accepts br and gzip', async () => {
            const response = await pinnedRequest(primary, {
                path: unique('/compress/gzip'),
                headers: { 'accept-encoding': 'br, gzip' }
            });

            expect(response.statusCode).toBe(200);
            expect(['gzip', 'br', 'identity']).toContain(encodingOf(response));
            expect(decode(response)).toBe(COMPRESSIBLE_BODY);
        }, TEST_TIMEOUT_MS);

        it('delivers a brotli response to a client that accepts brotli', async () => {
            const response = await pinnedRequest(primary, {
                path: unique('/compress/brotli'),
                headers: { 'accept-encoding': 'br' }
            });

            expect(response.statusCode).toBe(200);
            expect(['br', 'identity']).toContain(encodingOf(response));
            expect(decode(response)).toBe(COMPRESSIBLE_BODY);
        }, TEST_TIMEOUT_MS);

        it('serves an application that ignores Accept-Encoding and answers uncompressed', async () => {
            const response = await pinnedRequest(primary, {
                path: unique('/compress/identity'),
                headers: { 'accept-encoding': 'br' }
            });

            expect(response.statusCode).toBe(200);
            expect(decode(response)).toBe(COMPRESSIBLE_BODY);
        }, TEST_TIMEOUT_MS);

        it('never hands the client an encoding it did not accept', async () => {
            // The application answers in brotli regardless. A client that only speaks
            // gzip must still get something it can read — this is the one property in
            // this block that is a correctness requirement rather than an observation.
            const response = await pinnedRequest(primary, {
                path: unique('/compress/brotli'),
                headers: { 'accept-encoding': 'gzip' }
            });

            expect(response.statusCode).toBe(200);
            expect(encodingOf(response)).not.toBe('br');
            expect(decode(response)).toBe(COMPRESSIBLE_BODY);
        }, TEST_TIMEOUT_MS);

        it('never compresses for a client that asked for identity', async () => {
            const response = await pinnedRequest(primary, {
                path: unique('/compress/gzip'),
                headers: { 'accept-encoding': 'identity' }
            });

            expect(response.statusCode).toBe(200);
            expect(encodingOf(response)).toBe('identity');
            expect(response.body.toString()).toBe(COMPRESSIBLE_BODY);
        }, TEST_TIMEOUT_MS);

        it('lets a well-behaved application negotiate and still reach the client', async () => {
            const response = await pinnedRequest(primary, {
                path: unique('/compress/negotiated'),
                headers: { 'accept-encoding': 'br, gzip' }
            });

            expect(response.statusCode).toBe(200);
            expect(decode(response)).toBe(COMPRESSIBLE_BODY);
        }, TEST_TIMEOUT_MS);

        it('keeps a large compressed body byte-exact', async () => {
            // A short text payload would survive corruption that this catches: the
            // decompressor is the assertion.
            const response = await pinnedRequest(primary, {
                path: unique('/compress/gzip-large'),
                headers: { 'accept-encoding': 'gzip' }
            });

            expect(response.statusCode).toBe(200);

            const decoded = encodingOf(response) === 'gzip'
                ? zlib.gunzipSync(response.body)
                : response.body;

            expect(decoded.length).toBe(LARGE_BODY_SIZE);
            expect(sha256(decoded)).toBe(sha256(deterministicPayload(LARGE_BODY_SEED, LARGE_BODY_SIZE)));
        }, TEST_TIMEOUT_MS);
    });

    describe('failure modes', () => {
        it('survives a malformed response header and keeps serving', async () => {
            // The status matters less than the next assertion: a throw inside the ws
            // handler would take the server down, and every other tunnel on it.
            const bad = await pinnedRequest(primary, { path: unique('/headers/malformed') });

            expect([200, 502]).toContain(bad.statusCode);

            const next = await pinnedRequest(primary, { path: unique('/static/small') });

            expect(next.statusCode).toBe(200);
        }, TEST_TIMEOUT_MS);

        it('reports an unknown path from the local app rather than inventing a response', async () => {
            const response = await pinnedRequest(primary, { path: unique('/no/such/path') });

            expect(response.statusCode).toBe(404);
        }, TEST_TIMEOUT_MS);

        it('passes through status codes from the local app', async () => {
            const response = await pinnedRequest(primary, { path: unique('/status/418') });

            expect(response.statusCode).toBe(418);
        }, TEST_TIMEOUT_MS);
    });

    describe('websocket passthrough', () => {
        it('echoes text and binary frames', async () => {
            const socket = await openWebSocket(primary, '/ws');

            const text = await roundTrip(socket, 'hello');

            expect(text.toString()).toBe('hello');

            const binary = deterministicPayload(7, 4096);
            const echoed = await roundTrip(socket, binary);

            expect(sha256(echoed)).toBe(sha256(binary));

            socket.close();
        }, TEST_TIMEOUT_MS);

        it('replays the browser handshake headers to the local server', async () => {
            // open_data carries the browser's handshake headers for a WebSocket, and the
            // client replays them. Without that, Origin, cookies and Authorization are
            // gone by the time the local server decides whether to accept the socket.
            const socket = await openWebSocket(primary, '/ws/headers', {
                origin: `https://${cfg.vhost}`,
                cookie: 'fixture-ws=1',
                authorization: 'Bearer fixture-ws-token'
            });

            const seen = JSON.parse((await roundTrip(socket, 'headers?')).toString()) as Record<string, string>;

            expect(seen.origin).toBe(`https://${cfg.vhost}`);
            expect(seen.cookie).toContain('fixture-ws=1');
            expect(seen.authorization).toBe('Bearer fixture-ws-token');

            socket.close();
        }, TEST_TIMEOUT_MS);
    });

    describe('concurrency', () => {
        const maxConnections = Number(process.env.E2E_MAX_CONNECTIONS ?? '10');

        /** Fire more slow requests than there are slots and report how each ended. */
        async function burst(): Promise<number[]> {
            const results = await Promise.all(
                Array.from({ length: maxConnections + 2 }, () => pinnedRequest(primary, {
                    path: unique('/slow?ms=2000'),
                    timeoutMs: 45_000
                }).then((response) => response.statusCode).catch(() => 0))
            );

            return results;
        }

        it('releases every slot once a saturating burst drains', async () => {
            // The second burst is the assertion that matters. Capacity handed to a
            // queued request that then times out used to be lost for good, so a leak
            // shows up as the second burst failing immediately while the first passed.
            const first = await burst();

            expect(first.filter((status) => status === 200).length).toBeGreaterThan(0);

            const second = await burst();

            expect(second.filter((status) => status === 200).length)
                .toBeGreaterThanOrEqual(first.filter((status) => status === 200).length);
        }, TEST_TIMEOUT_MS * 3);
    });

    describe('quiet connections', () => {
        // How long a request may stay silent is the vhost's own idle timeout — an
        // Accelerator setting that applies just the same to a variant with an ordinary
        // upstream, not something the tunnel decides. So these stay well under the
        // smallest value we run against: what they exercise is whether the tunnel
        // carries a quiet connection at all, not where somebody's timeout is set.
        const quietMs = Number(process.env.E2E_QUIET_MS ?? '5000');
        const caseTimeoutMs = quietMs * 8;

        it('streams an SSE feed across a silence between events', async () => {
            // The SSE case under response integrity fires every 120 ms, so it proves
            // streaming without the connection ever going quiet. A real event feed does.
            const arrivals: number[] = [];
            const response = await pinnedRequest(primary, {
                path: unique(`/sse-idle?gap=${quietMs}`),
                deadlineMs: caseTimeoutMs,
                onChunk: (at) => arrivals.push(at)
            });

            expect(response.statusCode).toBe(200);
            expect(response.body.toString()).toContain('data: first');
            expect(response.body.toString()).toContain('data: second');
            expect(arrivals.length).toBeGreaterThanOrEqual(2);
        }, caseTimeoutMs + 30_000);

        it('answers a long-poll that sends nothing while it waits', async () => {
            // A comet or socket.io polling endpoint holds a request open saying nothing
            // at all, so it spends its whole life inside the idle budget rather than
            // resetting it with every chunk the way a stream does.
            const started = Date.now();
            const response = await pinnedRequest(primary, {
                path: unique(`/long-poll?ms=${quietMs}`),
                deadlineMs: caseTimeoutMs
            });

            expect(response.statusCode).toBe(200);
            expect(response.body.toString()).toBe('long-poll-done');
            expect(Date.now() - started).toBeGreaterThanOrEqual(quietMs - 1000);
        }, caseTimeoutMs + 30_000);
    });

    describe('internal endpoints', () => {
        it('are not reachable from client traffic', async () => {
            // Accelerator forwards /* to the tunnel, so without a guard its own
            // internal paths would be callable by anyone on a tunnelled vhost.
            const response = await pinnedRequest(primary, {
                path: `/__acc/dev-tunnel/affinity?variant=${encodeURIComponent(`${cfg.vhost}::${cfg.variant}`)}`
            });

            expect(response.statusCode).toBe(404);
        }, TEST_TIMEOUT_MS);
    });

    (cfg.secondaryEndpoint ? describe : describe.skip)('routing across entry points', () => {
        const secondary: PinnedTarget = targetFor(cfg, cfg.secondaryEndpoint ?? '');

        it('serves a tunnel registered through another entry point', async () => {
            // A tunnel is reachable from anywhere in Accelerator, not only through the
            // entry point it happened to register through.
            await waitForTunnel(secondary);

            const response = await pinnedRequest(secondary, { path: unique('/static/small') });

            expect(response.statusCode).toBe(200);
            expect(response.body.toString()).toBe('hello from the tunnel');
        }, READY_TIMEOUT_MS * 2);
    });
});

/**
 * Open a browser WebSocket, retrying the handshake.
 *
 * Only establishment is retried, never an assertion. A tunnel that has just
 * registered needs a moment before an upgrade routes to it, and a real network adds
 * its own noise; neither says anything about whether passthrough works.
 */
async function openWebSocket(
    target: PinnedTarget,
    path: string,
    headers?: Record<string, string>,
    attempts = 5
): Promise<WebSocket> {
    let lastError: Error = new Error('no attempt made');

    for (let attempt = 0; attempt < attempts; attempt++) {
        const socket = pinnedWebSocket(target, path, headers);

        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), 10_000);

                socket.once('open', () => {
                    clearTimeout(timer);
                    resolve();
                });
                socket.once('error', (err) => {
                    clearTimeout(timer);
                    reject(err);
                });
            });

            return socket;
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            socket.terminate();
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }

    throw new Error(`WebSocket never opened after ${attempts} attempts: ${lastError.message}`);
}

function roundTrip(socket: WebSocket, payload: string | Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket echo timed out')), 15_000);

        socket.once('message', (data, isBinary) => {
            clearTimeout(timer);
            resolve(isBinary ? (data as Buffer) : Buffer.from(data as ArrayBuffer));
        });

        socket.send(payload);
    });
}
