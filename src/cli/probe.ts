import { connect } from 'node:net';
import { logError } from './output.js';

/** Long enough for a loopback connection, short enough to not delay startup. */
const LOCAL_PROBE_TIMEOUT_MS = 500;

/**
 * Say so when the local application is not up yet.
 *
 * Starting the tunnel before the dev server is ordinary, and the tunnel is perfectly
 * healthy without it — but every request 502s while everything on screen looks fine,
 * so the one thing that must not happen is silence.
 */
export function isListening(host: string, port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const socket = connect({ host, port });

        const settle = (result: boolean): void => {
            socket.destroy();
            resolve(result);
        };

        socket.setTimeout(LOCAL_PROBE_TIMEOUT_MS);
        socket.once('connect', () => settle(true));
        socket.once('timeout', () => settle(false));
        socket.once('error', () => settle(false));
    });
}

export async function warnIfNothingIsListening(host: string, port: number): Promise<void> {
    const reachable = await isListening(host, port);

    if (!reachable) {
        logError(`warning: nothing is listening on ${host}:${port} yet`);
        logError('         the tunnel will connect, but requests will fail until your application starts');
    }
}

// ── check ────────────────────────────────────────────────────────────
