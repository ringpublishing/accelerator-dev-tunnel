import { readFileSync } from 'node:fs';
import { createTunnel } from '../../../src/index.js';
import type { Tunnel } from '../../../src/types.js';
import type { E2eConfig } from '../config.js';
import { pinnedRequest, type PinnedTarget } from './pinned.js';

export const READY_TIMEOUT_MS = 60_000;

/** Cache-buster, so a variant that does cache cannot mask a broken tunnel. */
export function unique(path: string): string {
    const separator = path.includes('?') ? '&' : '?';

    return `${path}${separator}_e2e=${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function targetFor(cfg: E2eConfig, endpoint: string = cfg.primaryEndpoint): PinnedTarget {
    return { endpoint, vhost: cfg.vhost, variant: cfg.variant, tls: cfg.tls };
}

/**
 * Bring up a tunnel against a specific entry point.
 *
 * `proxy` makes the client dial the given host while keeping Host and the TLS SNI on
 * the vhost, so the tunnel is established through that address and not through the
 * vhost's DNS.
 */
export async function startSession(cfg: E2eConfig, localPort: number, onError?: (err: Error) => void): Promise<Tunnel> {
    const tunnel = await createTunnel({
        token: cfg.token,
        vhost: cfg.vhost,
        variant: cfg.variant,
        host: '127.0.0.1',
        port: localPort,
        proxy: cfg.primaryEndpoint,
        // The client sends x-oa-variant itself, so registration selects the variant
        // without any help; this only has to match the entry point's scheme.
        noSsl: !cfg.tls,
        // A development vhost commonly carries a self-signed certificate. Trusting it
        // explicitly keeps hostname, expiry and chain checks on — which is the point of
        // the option, and why the suite uses it rather than disabling verification.
        ...(cfg.caFile ? { ca: readFileSync(cfg.caFile, 'utf-8') } : {})
    });

    // Surfaced rather than swallowed: a tunnel-side error usually explains a failure
    // far better than the assertion that trips.
    tunnel.on('error', onError ?? ((err): void => console.warn('[tunnel error]', err.message)));

    return tunnel;
}

/**
 * Poll until the whole path is live, rather than sleeping and hoping.
 *
 * `probePath` has to be something the application behind the tunnel actually serves:
 * the fixture answers `/static/small`, but a real dev server has its own idea of what
 * exists and will answer a made-up path with a 404 forever.
 */
export async function waitForTunnel(
    target: PinnedTarget,
    timeoutMs = READY_TIMEOUT_MS,
    probePath = '/static/small'
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = 0;

    for (;;) {
        try {
            const response = await pinnedRequest(target, { path: unique(probePath), timeoutMs: 10_000 });

            lastStatus = response.statusCode;

            if (response.statusCode === 200) {
                return;
            }
        } catch {
            // Connection-level failures are expected while the tunnel settles.
        }

        if (Date.now() >= deadline) {
            throw new Error(`Tunnel never became ready via ${target.endpoint} (last status ${lastStatus})`);
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}
