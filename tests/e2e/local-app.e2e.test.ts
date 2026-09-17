import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'node:net';
import { readE2eConfig, MISSING_CONFIG_MESSAGE } from './config.js';
import { pinnedRequest, PinnedTarget } from './harness/pinned.js';
import { READY_TIMEOUT_MS, startSession, targetFor, unique } from './harness/session.js';
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

const TEST_TIMEOUT_MS = 60_000;

/** A port nothing is listening on, found by binding one and letting it go. */
async function closedPort(): Promise<number> {
    const probe = net.createServer();

    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));

    const { port } = probe.address() as net.AddressInfo;

    await new Promise<void>((resolve) => probe.close(() => resolve()));

    return port;
}

/**
 * A connected tunnel with nothing behind it.
 *
 * Its own file because the tunnel has to point somewhere dead for the whole fixture,
 * and a variant accepts one control connection — so this cannot share a session with
 * the suite that needs a working application.
 */
describeE2e('local application unreachable', () => {
    const primary: PinnedTarget = targetFor(cfg);

    let tunnel: Tunnel;

    beforeAll(async () => {
        // No fixture server at all. createTunnel resolves on the control connection, which
        // does not depend on the local application being up — the client only dials it
        // once a request arrives.
        tunnel = await startSession(cfg, await closedPort(), () => {
            // Expected here: every request fails to reach the application. Swallowed so
            // the default handler does not fill the output with them.
        });
    }, READY_TIMEOUT_MS * 2);

    afterAll(async () => {
        await tunnel?.stop();
    });

    it('answers 502 rather than an empty 200', async () => {
        // The hazard the client's synthetic 502 head exists for: closing the data
        // connection silently makes the proxy end a response it never wrote, which Node
        // completes as an empty 200 — a wrong answer, and a cacheable one.
        const response = await pinnedRequest(primary, { path: unique('/static/small'), timeoutMs: 30_000 });

        // The status is the whole assertion. Whether the 502 carries an error page is
        // Accelerator's business, and an empty one is not a defect.
        expect(response.statusCode).toBe(502);
    }, TEST_TIMEOUT_MS);

    it('does not let the browser cache the failure', async () => {
        const response = await pinnedRequest(primary, { path: unique('/static/small'), timeoutMs: 30_000 });
        const cacheControl = String(response.headers['cache-control'] ?? '');

        expect(response.statusCode).toBe(502);
        expect(cacheControl).not.toMatch(/max-age=[1-9]/);
    }, TEST_TIMEOUT_MS);

    it('keeps the tunnel connected while requests fail', async () => {
        // A failing request is a failing request, not a broken tunnel. If the control
        // connection dropped here, the developer would see a takeover or a reconnect
        // storm instead of the 502 that tells them their app is down.
        await pinnedRequest(primary, { path: unique('/static/small'), timeoutMs: 30_000 });

        const second = await pinnedRequest(primary, { path: unique('/static/small'), timeoutMs: 30_000 });

        expect(second.statusCode).toBe(502);
    }, TEST_TIMEOUT_MS);
});
