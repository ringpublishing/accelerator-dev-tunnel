import * as http from 'node:http';
import * as https from 'node:https';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readE2eConfig, MISSING_CONFIG_MESSAGE } from './config.js';
import {
    startFixtureServer,
    waterfallAssetSize,
    WATERFALL_ASSET_COUNT,
    type FixtureServer
} from './fixture/server.js';
import { deterministicPayload, sha256 } from './fixture/payload.js';
import { pinnedHttp2Request, pinnedHttp2Session, pinnedRequest, type PinnedResponse } from './harness/pinned.js';
import { READY_TIMEOUT_MS, startSession, targetFor, unique, waitForTunnel } from './harness/session.js';
import type { Tunnel } from '../../src/types.js';

const config = readE2eConfig();
const describeE2e = config ? describe : describe.skip;

if (!config) {
    console.warn(MISSING_CONFIG_MESSAGE);
}

const cfg = config ?? {
    vhost: 'unconfigured.invalid',
    variant: 'NONE',
    token: '',
    primaryEndpoint: 'unconfigured.invalid',
    secondaryEndpoint: undefined,
    tls: true
};

const TEST_TIMEOUT_MS = 120_000;

/** `[0, 1, ... n-1]` — spelled out because the lint rules forbid an unused callback parameter. */
function range(count: number): number[] {
    const values: number[] = [];

    for (let index = 0; index < count; index++) {
        values.push(index);
    }

    return values;
}

/** What a browser opens per origin on HTTP/1.1. */
const BROWSER_PARALLELISM = 6;

/** Run `tasks` with at most `limit` in flight, preserving order in the result. */
async function withConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let next = 0;

    async function worker(): Promise<void> {
        for (;;) {
            const index = next++;

            if (index >= tasks.length) {
                return;
            }

            results[index] = await (tasks[index] as () => Promise<T>)();
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));

    return results;
}

function expectedAsset(index: number): Buffer {
    return deterministicPayload(index + 1, waterfallAssetSize(index));
}

function assertAssets(responses: PinnedResponse[]): void {
    responses.forEach((response, index) => {
        expect(response.statusCode).toBe(200);
        expect(response.body.length).toBe(waterfallAssetSize(index));
        expect(sha256(response.body)).toBe(sha256(expectedAsset(index)));
    });
}

/**
 * A page load, not a synthetic burst.
 *
 * The existing concurrency case fires identical slow requests to detect a slot leak.
 * This is the shape a developer actually produces: one document followed by a few dozen
 * assets of assorted sizes, fetched over a small number of connections. It is where
 * response framing errors surface, because several responses share one socket in
 * sequence — exactly the condition under which a body that overruns or underruns its
 * length corrupts the *next* response rather than its own.
 */
describeE2e('waterfall', (): void => {
    const target = targetFor(cfg);

    let fixture: FixtureServer;
    let tunnel: Tunnel;

    beforeAll(async () => {
        fixture = await startFixtureServer();
        tunnel = await startSession(cfg, fixture.port);
        await waitForTunnel(target);
    }, READY_TIMEOUT_MS * 2);

    afterAll(async () => {
        await tunnel?.stop();
        await fixture?.close();
    });

    it('serves a document and every asset it references', async () => {
        const index = await pinnedRequest(target, { path: unique('/waterfall/index.html') });

        expect(index.statusCode).toBe(200);
        expect(index.body.toString().match(/\/waterfall\/asset\/\d+/g)).toHaveLength(WATERFALL_ASSET_COUNT);
    }, TEST_TIMEOUT_MS);

    it('delivers every asset intact over a browser-sized connection pool', async () => {
        // keepAlive with a handful of sockets is what a browser does on HTTP/1.1, and
        // it is the interesting case: responses are pipelined through the same sockets,
        // so one mis-framed body would corrupt whichever response followed it.
        // The agent has to match the scheme, and the certificate here is self-signed —
        // the same allowance pinnedRequest already makes, since the name is checked
        // through SNI and Host rather than against the entry point's address.
        const agent = cfg.tls
            ? new https.Agent({ keepAlive: true, maxSockets: BROWSER_PARALLELISM, rejectUnauthorized: false })
            : new http.Agent({ keepAlive: true, maxSockets: BROWSER_PARALLELISM });

        try {
            const responses = await withConcurrency(
                range(WATERFALL_ASSET_COUNT).map((index) => () => pinnedRequest(target, {
                    agent,
                    path: unique(`/waterfall/asset/${index}`)
                })),
                BROWSER_PARALLELISM
            );

            assertAssets(responses);
        } finally {
            agent.destroy();
        }
    }, TEST_TIMEOUT_MS);

    it('serves a page load from connections established before the requests arrived', async () => {
        // What the pool is for. Every tunnelled request needs a data connection to the
        // proxy, and opening one is a TCP handshake, a TLS handshake and a WebSocket
        // upgrade across the internet — paid on the request unless the connection is
        // already there. Asserted through the counters rather than through timing,
        // because a latency assertion against a shared environment would be a coin toss.
        const wave = (): Promise<PinnedResponse[]> => withConcurrency(
            range(BROWSER_PARALLELISM).map((index) => () => pinnedRequest(target, {
                path: unique(`/waterfall/asset/${index}`)
            })),
            BROWSER_PARALLELISM
        );

        // The first wave is what tells the pool that one warm connection is not enough.
        await wave();
        expect(tunnel.stats().pool.supported).toBe(true);
        expect(tunnel.stats().pool.target).toBeGreaterThan(1);

        // Let the pool refill at the size the first wave pushed it to.
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const before = tunnel.stats().pool.hits;
        const responses = await wave();
        const served = tunnel.stats().pool.hits - before;

        assertAssets(responses);
        // Not all of them: the pool refills asynchronously, so a fast enough burst can
        // still outrun it. Most of a browser-sized wave arriving on a warm connection is
        // the claim being made.
        expect(served).toBeGreaterThanOrEqual(Math.ceil(BROWSER_PARALLELISM / 2));
    }, TEST_TIMEOUT_MS);

    it('opens one connection to the local application per request', async () => {
        // Not a defect, but a cost worth knowing: the proxy appends `Connection: close`
        // to everything it forwards, so a page of assets is a page of TCP handshakes
        // against the developer's dev server, however well the browser pools its own.
        const before = fixture.connectionCount();
        const count = 8;

        await withConcurrency(
            range(count).map((index) => () => pinnedRequest(target, {
                path: unique(`/waterfall/asset/${index}`)
            })),
            BROWSER_PARALLELISM
        );

        expect(fixture.connectionCount() - before).toBeGreaterThanOrEqual(count);
    }, TEST_TIMEOUT_MS);

    // HTTP/2 needs ALPN, so the entry point has to terminate TLS with a certificate for
    // the vhost. Cleartext h2c is refused on port 80, and a private-endpoint vhost has
    // no certificate at all — so this is skipped wherever E2E_TLS=false.
    (cfg.tls ? describe : describe.skip)('over HTTP/2', () => {
        it('multiplexes the whole page over a single session', async () => {
            const session = pinnedHttp2Session(target);

            try {
                await new Promise<void>((resolve, reject) => {
                    session.once('connect', () => resolve());
                    session.once('error', reject);
                });

                // No concurrency limit: the point of h2 is that one connection carries
                // them all, so anything that serialises per stream shows up here.
                const responses = await Promise.all(
                    range(WATERFALL_ASSET_COUNT).map((index) => pinnedHttp2Request(
                        session,
                        target,
                        unique(`/waterfall/asset/${index}`)
                    ))
                );

                assertAssets(responses);
            } finally {
                session.close();
            }
        }, TEST_TIMEOUT_MS);

        it('serves the document and its assets on the same session', async () => {
            const session = pinnedHttp2Session(target);

            try {
                await new Promise<void>((resolve, reject) => {
                    session.once('connect', () => resolve());
                    session.once('error', reject);
                });

                const index = await pinnedHttp2Request(session, target, unique('/waterfall/index.html'));

                expect(index.statusCode).toBe(200);

                const asset = await pinnedHttp2Request(session, target, unique('/waterfall/asset/0'));

                expect(asset.statusCode).toBe(200);
                expect(sha256(asset.body)).toBe(sha256(expectedAsset(0)));
            } finally {
                session.close();
            }
        }, TEST_TIMEOUT_MS);
    });
});
