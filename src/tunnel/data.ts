import { WebSocket } from 'ws';
import * as net from 'node:net';
import type {
    ResolvedConfig
} from '../types.js';
import {
    OpenDataMessage
} from '../protocol.js';
import {
    TunnelEmitter
} from '../emitter.js';
import type { DataConnectionPool } from './pool.js';
import { buildWsConnectionParams } from './ws-options.js';

/** Sent when the local app cannot be reached, so the browser sees a 502 and not an empty 200. */
const BAD_GATEWAY_RESPONSE = [
    'HTTP/1.1 502 Bad Gateway',
    'Content-Length: 0',
    'Connection: close',
    '',
    ''
].join('\r\n');

/** How long to wait for the local app before giving up, well inside the proxy's 15s. */
const LOCAL_CONNECT_TIMEOUT_MS = 5_000;

/** Cap on request bytes held while the local connection is still being established. */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

/** Pause the local socket once this much is queued inside ws. Matches the proxy's cap. */
const SEND_HIGH_WATER_MARK = 64 * 1024;

/** Reads the status out of a response head, so the tunnel can report how a request ended. */
const STATUS_LINE_RE = /^HTTP\/\d\.\d (\d{3})/;

/**
 * Reports how a request ended, exactly once.
 *
 * Every path has to end in a report — a request that produces no line leaves someone
 * watching the terminal unable to tell a slow application from a broken one.
 */
function responseReporter(msg: OpenDataMessage, tunnel: TunnelEmitter): (statusCode: number) => void {
    const startedAt = Date.now();
    let reported = false;

    return (statusCode: number): void => {
        if (reported) {
            return;
        }

        reported = true;
        tunnel.emit('response', {
            method: msg.method,
            path: msg.path,
            remoteIp: msg.remoteIp,
            statusCode,
            durationMs: Date.now() - startedAt
        });
    };
}

/** Opens a data connection dedicated to one request, naming it in the upgrade headers. */
function openDataWs(requestId: string, config: ResolvedConfig): WebSocket {
    const { url, options } = buildWsConnectionParams(
        config,
        '/__acc/dev-tunnel/data',
        {
            'x-oa-variant': `${config.vhost}::${config.variant}`,
            'x-tunnel-token': config.token,
            'x-tunnel-request-id': requestId
        }
    );

    return new WebSocket(url, options);
}

interface DataConnection {
    dataWs: WebSocket;
    /** True when the connection came from the pool and is already open and bound. */
    pooled: boolean;
    report: (statusCode: number) => void;
}

/**
 * Get a data connection for a request, and arrange for its outcome to be reported.
 *
 * Both directions — a plain request and a tunnelled WebSocket — need exactly this and
 * differ only in what they do with the connection afterwards. Having it once means a
 * change like adding the pool, or reporting the status, lands in one place instead of
 * being applied twice and diverging on the third occasion.
 */
function acquireDataConnection(
    msg: OpenDataMessage,
    config: ResolvedConfig,
    tunnel: TunnelEmitter,
    pool: DataConnectionPool | undefined
): DataConnection {
    const report = responseReporter(msg, tunnel);
    const pooled = pool?.acquire(msg.requestId);

    return { dataWs: pooled ?? openDataWs(msg.requestId, config), pooled: Boolean(pooled), report };
}

/**
 * Run `onReady` when the connection is usable.
 *
 * A pooled connection is already open and already bound, so there is no 'open' left to
 * wait for and its handlers have to go on in this same tick — before the proxy's first
 * frame can arrive.
 */
function whenReady(connection: DataConnection, onReady: () => void): void {
    if (connection.pooled) {
        onReady();

        return;
    }

    connection.dataWs.on('open', onReady);
}

/**
 * Opens a data WebSocket and a local TCP connection, then pipes raw bytes
 * bidirectionally between them.
 *
 * If the local app is unreachable this reports a 502 down the tunnel. This is NOT a
 * fatal error for the tunnel itself — only for the one request.
 */
export function handleDataConnection(
    msg: OpenDataMessage,
    config: ResolvedConfig,
    tunnel: TunnelEmitter,
    pool?: DataConnectionPool
): void {
    if (msg.isWebSocket) {
        handleWsDataConnection(msg, config, tunnel, pool);

        return;
    }

    let localSocket: net.Socket | undefined;

    const connection = acquireDataConnection(msg, config, tunnel, pool);
    const { dataWs, report } = connection;

    // Top-level close handler — fires even if WS never reached 'open'.
    dataWs.on('close', () => {
        // Nothing came back and nothing reported a failure: the connection ended
        // mid-flight. Zero says that, rather than leaving the request unaccounted for.
        report(0);

        if (localSocket && !localSocket.destroyed) {
            localSocket.destroy();
        }
    });

    dataWs.on('error', (err) => {
        tunnel.emit(
            'error',
            new Error(`Data WebSocket error for ${msg.requestId}: ${err instanceof Error ? err.message : String(err)}`)
        );
    });

    const onReady = (): void => {
        // Token and requestId are passed via upgrade headers (or, for a pooled
        // connection, by the bind frame the pool already sent) — no init message needed.

        // Buffer incoming WS messages until TCP socket is ready.
        const pendingChunks: Buffer[] = [];
        let pendingBytes = 0;
        let socketReady = false;
        // Declared here because the error handlers below close over it, but only
        // assigned once the socket exists.
        // eslint-disable-next-line prefer-const
        let connectTimer: ReturnType<typeof setTimeout>;

        dataWs.on('message', (data, isBinary) => {
            const buf = isBinary
                ? (data as Buffer)
                : Buffer.from(data as ArrayBuffer);

            if (socketReady && localSocket && !localSocket.destroyed) {
                localSocket.write(buf);

                return;
            }

            pendingBytes += buf.length;

            if (pendingBytes > MAX_PENDING_BYTES) {
                // The local app is not accepting the connection and the request body
                // keeps coming; buffering it without limit is how a laptop runs out
                // of memory.
                failWithGateway(`Request body exceeded ${MAX_PENDING_BYTES} bytes while waiting for ${config.host}:${config.port}`);

                return;
            }

            pendingChunks.push(buf);
        });

        // Open TCP connection to local app
        const failWithGateway = (message: string): void => {
            report(502);
            tunnel.emit('error', new Error(message));

            // Report a real 502 rather than letting the proxy end an unwritten response,
            // which Node completes as an empty — and cacheable — 200.
            if (dataWs.readyState === WebSocket.OPEN) {
                dataWs.send(Buffer.from(BAD_GATEWAY_RESPONSE, 'ascii'));
            }

            dataWs.close();
        };

        const onConnectError = (err: Error): void => {
            clearTimeout(connectTimer);
            failWithGateway(`Cannot connect to ${config.host}:${config.port}: ${err.message}`);
        };

        const socket = net.createConnection({ host: config.host, port: config.port }, () => {
            clearTimeout(connectTimer);
            socket.setTimeout(0);
            // Connection established — swap error handler
            socket.off('error', onConnectError);
            socketReady = true;

            // Flush buffered data from edge
            for (const chunk of pendingChunks) {
                if (!socket.destroyed) {
                    socket.write(chunk);
                }
            }

            pendingChunks.length = 0;
            pendingBytes = 0;

            // Pipe: local TCP → data WS
            let pendingSends = 0;
            let localEnded = false;

            let headSeen = false;

            socket.on('data', (chunk) => {
                if (!headSeen) {
                    headSeen = true;

                    const status = STATUS_LINE_RE.exec(chunk.subarray(0, 16).toString('latin1'));

                    if (status?.[1]) {
                        report(Number(status[1]));
                    }
                }

                if (dataWs.readyState !== WebSocket.OPEN) {
                    // Dropping bytes silently truncates the response; stop the source instead.
                    socket.destroy();

                    return;
                }

                pendingSends++;
                dataWs.send(chunk, (err) => {
                    pendingSends--;

                    if (err) {
                        tunnel.emit('error', new Error(`WS send error for ${msg.requestId}: ${err.message}`));
                    }

                    if (socket.isPaused() && dataWs.bufferedAmount <= SEND_HIGH_WATER_MARK) {
                        socket.resume();
                    }

                    if (localEnded && pendingSends === 0 && dataWs.readyState === WebSocket.OPEN) {
                        dataWs.close();
                    }
                });

                // A fast local app on a slow uplink would otherwise queue the whole
                // response inside ws.
                if (dataWs.bufferedAmount > SEND_HIGH_WATER_MARK) {
                    socket.pause();
                }
            });

            socket.on('end', () => {
                localEnded = true;

                if (pendingSends === 0 && dataWs.readyState === WebSocket.OPEN) {
                    dataWs.close();
                }
            });

            socket.on('close', () => {
                if (!localEnded && (dataWs.readyState === WebSocket.OPEN || dataWs.readyState === WebSocket.CONNECTING)) {
                    dataWs.close();
                }
            });

            socket.on('error', (err) => {
                tunnel.emit('error', new Error(`Local connection error for ${msg.requestId}: ${err.message}`));
                socket.destroy();
                dataWs.close();
            });
        });

        connectTimer = setTimeout(() => {
            socket.destroy();
            failWithGateway(`Timed out after ${LOCAL_CONNECT_TIMEOUT_MS}ms connecting to ${config.host}:${config.port}`);
        }, LOCAL_CONNECT_TIMEOUT_MS);

        localSocket = socket;
        socket.on('error', onConnectError);
    };

    whenReady(connection, onReady);
}

/**
 * Opens a data WebSocket and connects to the local app as a WebSocket,
 * then relays WS frames bidirectionally through the tunnel.
 * Used for browser WebSocket connections (e.g. Vite HMR).
 */
function handleWsDataConnection(
    msg: OpenDataMessage,
    config: ResolvedConfig,
    tunnel: TunnelEmitter,
    pool?: DataConnectionPool
): void {
    const connection = acquireDataConnection(msg, config, tunnel, pool);
    const { dataWs, report } = connection;

    dataWs.on('close', () => report(0));

    dataWs.on('error', (err) => {
        tunnel.emit(
            'error',
            new Error(`WS data WebSocket error for ${msg.requestId}: ${err instanceof Error ? err.message : String(err)}`)
        );
    });

    const onReady = (): void => {
        // Buffer frames arriving from the proxy until local WS is ready.
        const pendingFrames: { data: Buffer; isBinary: boolean; }[] = [];
        let localWsReady = false;

        const localWsUrl = `ws://${config.host}:${config.port}${msg.path}`;
        // Replay what the browser negotiated. Sec-WebSocket-Protocol has to go through
        // ws's `protocols` argument rather than a header, or ws will not treat the
        // server's selection as a match.
        const relayed = { ...msg.headers };
        const protocolHeader = relayed['sec-websocket-protocol'];

        delete relayed['sec-websocket-protocol'];

        const protocols = protocolHeader
            ? protocolHeader.split(',').map((entry) => entry.trim()).filter(Boolean)
            : [];

        const localWs = protocols.length > 0
            ? new WebSocket(localWsUrl, protocols, { headers: relayed })
            : new WebSocket(localWsUrl, { headers: relayed });

        dataWs.on('message', (data, isBinary) => {
            const buf = isBinary ? (data as Buffer) : Buffer.from(data as ArrayBuffer);

            if (localWsReady && localWs.readyState === WebSocket.OPEN) {
                localWs.send(buf, { binary: isBinary });
            } else {
                pendingFrames.push({ data: buf, isBinary });
            }
        });

        localWs.on('open', () => {
            localWsReady = true;
            // The local application accepted the upgrade; 101 is what the browser sees.
            report(101);

            for (const { data, isBinary } of pendingFrames) {
                if (localWs.readyState === WebSocket.OPEN) {
                    localWs.send(data, { binary: isBinary });
                }
            }

            pendingFrames.length = 0;

            localWs.on('message', (data, isBinary) => {
                if (dataWs.readyState === WebSocket.OPEN) {
                    dataWs.send(data as Buffer, { binary: isBinary });
                }
            });
        });

        localWs.on('error', (err) => {
            report(502);
            tunnel.emit('error', new Error(`Local WS error for ${msg.requestId}: ${err.message}`));
            dataWs.close();
        });

        localWs.on('close', () => {
            if (dataWs.readyState === WebSocket.OPEN || dataWs.readyState === WebSocket.CONNECTING) {
                dataWs.close();
            }
        });

        dataWs.on('close', () => {
            if (localWs.readyState === WebSocket.OPEN || localWs.readyState === WebSocket.CONNECTING) {
                localWs.close();
            }
        });
    };

    whenReady(connection, onReady);
}
