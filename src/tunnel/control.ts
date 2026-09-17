import { WebSocket } from 'ws';
import {
    type ResolvedConfig,
    RECONNECT_JITTER,
    TERMINAL_CLOSE_CODES,
    CONTROL_LIVENESS_TIMEOUT_MS,
    reconnectDelayFor
} from '../types.js';
import {
    type ControlMessage,
    type OpenDataMessage
} from '../protocol.js';
import {
    AuthError,
    TakeoverError
} from '../errors.js';
import {
    type TunnelEmitter
} from '../emitter.js';
import { handleDataConnection } from './data.js';
import type { DataConnectionPool } from './pool.js';
import { buildWsConnectionParams } from './ws-options.js';

/**
 * Manages the control WebSocket connection lifecycle:
 * auth handshake, reconnect with exponential backoff, idle timeout, and
 * dispatching `open_data` messages to data connection handler.
 */
export function startControl(
    config: ResolvedConfig,
    tunnel: TunnelEmitter,
    signal: AbortSignal,
    pool?: DataConnectionPool
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let resolved = false;
        let reconnectAttempt = 0;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
        let ws: WebSocket | undefined;
        let intentionalClose = false;

        const resetIdleTimer = (): void => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                clearTimeout(reconnectTimer);
                tunnel.emit('disconnect', 'idle_timeout');
                intentionalClose = true;
                ws?.close();

                if (!resolved) {
                    resolved = true;
                    reject(new Error('Idle timeout elapsed before the tunnel was established'));
                }
            }, config.idleTimeout * 1000);
        };

        const cleanup = (): void => {
            clearTimeout(idleTimer);
            clearTimeout(reconnectTimer);
            pool?.stop();
            intentionalClose = true;

            if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
                ws.close();
            }
        };

        // React to external abort (tunnel.stop())
        signal.addEventListener('abort', () => {
            cleanup();
            tunnel.emit('disconnect', 'stopped');

            if (!resolved) {
                resolved = true;
                resolve();
            }
        }, { once: true });

        const connect = (): void => {
            if (signal.aborted) {
                return;
            }

            const { url, options: wsOptions } = buildWsConnectionParams(
                config,
                '/__acc/dev-tunnel/register',
                { 'x-oa-variant': `${config.vhost}::${config.variant}` }
            );

            const currentWs = new WebSocket(url, wsOptions);

            ws = currentWs;

            // The proxy pings every 20s. Without a watchdog on those, a half-open TCP
            // (laptop sleep, VPN drop, NAT rebind) leaves us believing we are connected
            // while every request 502s on the other side.
            let livenessTimer: ReturnType<typeof setTimeout> | undefined;

            const armLiveness = (): void => {
                clearTimeout(livenessTimer);
                livenessTimer = setTimeout(() => {
                    // terminate(), not close(): a half-open socket will not complete a
                    // closing handshake, and the 'close' handler drives the reconnect.
                    currentWs.terminate();
                }, CONTROL_LIVENESS_TIMEOUT_MS);
            };

            currentWs.on('ping', armLiveness);
            currentWs.on('pong', armLiveness);
            currentWs.on('close', () => clearTimeout(livenessTimer));

            currentWs.on('open', () => {
                armLiveness();
                // Send auth immediately
                currentWs.send(JSON.stringify({ type: 'auth', token: config.token }));
            });

            currentWs.on('message', (raw) => {
                let msg: ControlMessage;

                try {
                    msg = JSON.parse(raw.toString()) as ControlMessage;
                } catch {
                    return; // ignore malformed messages
                }

                switch (msg.type) {
                    case 'auth_ok':
                        reconnectAttempt = 0;
                        resetIdleTimer();
                        // Only warm connections once the proxy has accepted us — before
                        // auth they would just be rejected one after another.
                        pool?.start();
                        tunnel.emit('connect');

                        if (!resolved) {
                            resolved = true;
                            resolve();
                        }

                        break;
                    case 'auth_error': {
                        const isTakeover = msg.reason === 'replaced';
                        const err = isTakeover ? new TakeoverError() : new AuthError(msg.reason);
                        cleanup();
                        tunnel.emit('disconnect', isTakeover ? 'replaced' : 'auth_error');

                        if (!resolved) {
                            resolved = true;
                            reject(err);
                        } else {
                            // Fatal auth failure during reconnect — surface as error
                            tunnel.emit('error', err);
                        }

                        break;
                    }
                    case 'shutdown':
                        cleanup();
                        tunnel.emit('disconnect', 'shutdown');

                        if (!resolved) {
                            resolved = true;
                            resolve();
                        }

                        break;
                    case 'open_data':
                        resetIdleTimer();
                        dispatchData(msg, config, tunnel, pool);
                        break;
                }
            });

            currentWs.on('close', (code) => {
                // Warm connections to a proxy we are no longer registered with are dead
                // weight; the pool restarts on the next auth_ok.
                pool?.stop();

                if (intentionalClose || signal.aborted) {
                    return;
                }

                // Some closes will never succeed on retry — a rejected token, a
                // malformed frame, an auth timeout. The last of those arrives with no
                // preceding auth_error frame at all, so without inspecting the code we
                // would reconnect forever against a server that keeps refusing us.
                if (TERMINAL_CLOSE_CODES.includes(code)) {
                    const err = new Error(`Connection refused by the server (close code ${code})`);

                    cleanup();
                    tunnel.emit('disconnect', 'rejected');

                    if (!resolved) {
                        resolved = true;
                        reject(err);
                    } else {
                        tunnel.emit('error', err);
                    }

                    return;
                }

                if (config.maxReconnectAttempts > 0 && reconnectAttempt >= config.maxReconnectAttempts) {
                    const err = new Error(`Giving up after ${reconnectAttempt} reconnect attempts`);

                    cleanup();
                    tunnel.emit('disconnect', 'reconnect_exhausted');

                    if (!resolved) {
                        resolved = true;
                        reject(err);
                    } else {
                        tunnel.emit('error', err);
                    }

                    return;
                }

                // Unexpected disconnect → reconnect
                reconnectAttempt++;
                // Jitter matters here: when the proxy restarts, every connected client
                // wakes on the same schedule and stampedes it otherwise.
                const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER;
                const delay = Math.round(reconnectDelayFor(reconnectAttempt) * jitter);

                tunnel.emit('reconnect', reconnectAttempt);

                reconnectTimer = setTimeout(() => {
                    if (!signal.aborted) {
                        connect();
                    }
                }, delay);
            });

            currentWs.on('error', (err) => {
                const error = err instanceof Error ? err : new Error(String(err));
                const isTlsError = isTlsRelatedError(error);

                if (isTlsError) {
                    const wrappedError = new Error(
                        `TLS connection failed to ${config.vhost}: ${error.message}. `
                        + 'The vhost may not support HTTPS. Ensure the vhost has a valid SSL certificate '
                        + 'and is accessible via HTTPS.'
                    );

                    wrappedError.cause = error;

                    if (!resolved) {
                        resolved = true;
                        intentionalClose = true;
                        reject(wrappedError);

                        return;
                    }

                    tunnel.emit('error', wrappedError);

                    return;
                }

                // If the initial connection attempt fails before auth, reject the
                // createTunnel promise immediately — the caller has no listeners yet
                // and would be stuck waiting forever with no feedback.
                if (!resolved) {
                    resolved = true;
                    intentionalClose = true;
                    reject(error);

                    return;
                }

                // After the first successful auth the close event handles reconnect;
                // we only emit the error here for caller visibility.
                tunnel.emit('error', error);
            });
        };

        connect();
    });
}

function dispatchData(
    msg: OpenDataMessage,
    config: ResolvedConfig,
    tunnel: TunnelEmitter,
    pool?: DataConnectionPool
): void {
    tunnel.emit('request', {
        method: msg.method,
        path: msg.path,
        remoteIp: msg.remoteIp
    });

    handleDataConnection(msg, config, tunnel, pool);
}

const TLS_ERROR_CODES = new Set([
    'EPROTO',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT',
    'ERR_SSL_WRONG_VERSION_NUMBER'
]);

function isTlsRelatedError(err: Error): boolean {
    const code = (err as NodeJS.ErrnoException).code;

    if (code && TLS_ERROR_CODES.has(code)) {
        return true;
    }

    const msg = err.message.toLowerCase();

    return msg.includes('ssl') || msg.includes('tls') || msg.includes('certificate');
}
