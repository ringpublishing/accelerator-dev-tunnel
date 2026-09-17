import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readE2eConfig, MISSING_CONFIG_MESSAGE } from './config.js';
import { startFixtureServer, type FixtureServer } from './fixture/server.js';
import { pinnedRequest } from './harness/pinned.js';
import { READY_TIMEOUT_MS, startSession, targetFor, unique, waitForTunnel } from './harness/session.js';
import type { Tunnel, DisconnectReason } from '../../src/types.js';

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

/**
 * How long to allow for a takeover to reach the displaced client.
 *
 * Some takeovers are settled immediately, others on the proxy's next reconcile pass —
 * so measured runs land at either a few seconds or about fifteen. This allows several
 * passes so the assertion is not racing that interval.
 */
const TAKEOVER_GRACE_MS = 45_000;

/** Poll until `predicate` holds, or give up. Returns either way; the assertion decides. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}

/**
 * Tunnel lifecycle, driven from the outside.
 *
 * A developer restarts their client constantly — on every code change to the tunnel
 * config, every network blip, every laptop lid. It is the single most common thing that
 * happens to a tunnel, and it is where the worst defect in this feature lived: a
 * replaced control connection used to unregister its own replacement, leaving the
 * client holding a socket the proxy had no record of, silently, until someone restarted
 * again. That was fixed with a unit test; these are the assertions from the outside.
 *
 * Kept in its own file because every case here owns the tunnel's lifetime, and the
 * rest of the suite assumes one that stays up.
 */
describeE2e('tunnel lifecycle', (): void => {
    const target = targetFor(cfg);

    let fixture: FixtureServer;
    const opened: Tunnel[] = [];

    async function open(onError?: (err: Error) => void): Promise<Tunnel> {
        const tunnel = await startSession(cfg, fixture.port, onError);

        opened.push(tunnel);

        return tunnel;
    }

    beforeAll(async () => {
        fixture = await startFixtureServer();
    }, READY_TIMEOUT_MS);

    afterAll(async () => {
        await Promise.all(opened.map((tunnel) => tunnel.stop().catch(() => undefined)));
        await fixture?.close();
    });

    it('serves traffic again after the client restarts', async () => {
        // The regression that matters. Before the identity guard on unregister, the
        // second session registered and was then unregistered by the first session's
        // own close handler firing late — so this request would 502 forever.
        const first = await open();

        await waitForTunnel(target);
        await first.stop();

        const second = await open();

        await waitForTunnel(target);

        const response = await pinnedRequest(target, { path: unique('/static/small') });

        expect(response.statusCode).toBe(200);
        expect(response.body.toString()).toBe('hello from the tunnel');

        await second.stop();
    }, TEST_TIMEOUT_MS);

    it('survives several restarts in a row', async () => {
        // One restart can pass by luck of timing; the failure mode was a race.
        for (let attempt = 0; attempt < 3; attempt++) {
            const tunnel = await open();

            await waitForTunnel(target);

            const response = await pinnedRequest(target, { path: unique('/static/small') });

            expect(response.statusCode).toBe(200);

            await tunnel.stop();
        }
    }, TEST_TIMEOUT_MS * 2);

    it('displaces the first client when a second one claims the same variant', async () => {
        // Two clients claiming the same variant do not always meet each other directly.
        // The ones that do are settled on the spot; the rest used to leave the first
        // client holding a socket no traffic would reach, with nothing to tell it.
        //
        // The proxy now closes any connection a newer registration superseded, which is
        // what makes this assertion unconditional: the displaced client is always told.
        const reasons: DisconnectReason[] = [];
        const first = await open(() => undefined);

        first.on('disconnect', (reason) => reasons.push(reason));

        await waitForTunnel(target);

        const second = await open();

        await waitForTunnel(target);

        const response = await pinnedRequest(target, { path: unique('/static/small') });

        expect(response.statusCode).toBe(200);
        expect(response.body.toString()).toBe('hello from the tunnel');

        // Immediate when the two clients meet directly, otherwise on a reconcile pass.
        await waitFor(() => reasons.includes('replaced'), TAKEOVER_GRACE_MS);

        // A displaced client must learn it was displaced, not that its token is bad.
        expect(reasons).toContain('replaced');
        expect(reasons).not.toContain('auth_error');

        await second.stop();
    }, TEST_TIMEOUT_MS + TAKEOVER_GRACE_MS);

    it('is reachable again after the client reconnects', async () => {
        // A reconnecting client is rarely handed back to the same place, so the routing
        // to it has to be refreshed and anything stale dropped. Otherwise requests keep
        // arriving where the tunnel no longer is.
        const first = await open();

        await waitForTunnel(target);
        await first.stop();

        const second = await open();

        await waitForTunnel(target);

        // Several requests, because stale routing fails intermittently rather than
        // outright: it depends on which cached value each one hits.
        const statuses = await Promise.all(
            Array.from({ length: 8 }, () => pinnedRequest(target, { path: unique('/static/small') })
                .then((response) => response.statusCode)
                .catch(() => 0))
        );

        expect(statuses.every((status) => status === 200)).toBe(true);

        await second.stop();
    }, TEST_TIMEOUT_MS);
});
