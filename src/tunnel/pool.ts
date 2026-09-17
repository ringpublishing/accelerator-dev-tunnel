import { WebSocket } from 'ws';
import type {
    PoolStats,
    ResolvedConfig
} from '../types.js';
import { buildWsConnectionParams } from './ws-options.js';

/**
 * Ceiling on warm connections. Browsers open around six connections per host, so a
 * larger pool would only ever be warm for load the browser cannot generate.
 */
const POOL_MAX = 6;

/** How often the pool re-evaluates its size. */
const SWEEP_INTERVAL_MS = 15_000;

/**
 * Keepalive on a parked connection. Anything between here and Accelerator drops idle
 * connections, typically after a minute, and a connection reclaimed by the pool after it
 * was already dropped is worse than no pool at all.
 */
const PARK_PING_INTERVAL_MS = 20_000;

/**
 * Consecutive failed warm-ups before the pool stops trying until the next request.
 * Retrying a broken path on a timer would just be a background reconnect loop.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

interface ParkedConnection {
    ws: WebSocket;
    ping: ReturnType<typeof setInterval>;
}

/**
 * A pool of pre-established data connections to the proxy.
 *
 * Every tunnelled request needs a data connection, and opening one costs a TCP
 * handshake plus a TLS handshake plus a WebSocket upgrade against a remote proxy —
 * latency that lands squarely on the request. Establishing them ahead of time moves
 * that cost off the critical path.
 *
 * A pooled connection serves exactly one request and is then closed, the same as an
 * on-demand one; the pool refills in the background. Reusing a connection across
 * requests would mean framing request boundaries over a channel that currently carries
 * opaque bytes, and multiplexing several requests onto one connection was explicitly
 * not wanted. Pre-establishing gets the latency win without either.
 *
 * The size is demand-driven: one connection at rest, growing whenever a request drains
 * the pool, decaying back down when nothing asks for connections. So an idle tunnel
 * holds one socket, and a page load that fans out to six gets six.
 */
export class DataConnectionPool {
    private readonly config: ResolvedConfig;

    private readonly parked: ParkedConnection[] = [];

    private opening = 0;

    private target = 1;

    private sweeper: ReturnType<typeof setInterval> | null = null;

    private stopped = false;

    private supported = true;

    private consecutiveFailures = 0;

    private demandSinceSweep = false;

    private hits = 0;

    private misses = 0;

    constructor(config: ResolvedConfig) {
        this.config = config;
    }

    public start(): void {
        if (this.sweeper) {
            return;
        }

        this.stopped = false;
        this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
        this.sweeper.unref();
        this.refill();
    }

    public stop(): void {
        this.stopped = true;

        if (this.sweeper) {
            clearInterval(this.sweeper);
            this.sweeper = null;
        }

        while (this.parked.length > 0) {
            this.discard(this.parked.pop() as ParkedConnection);
        }
    }

    public stats(): PoolStats {
        return {
            hits: this.hits,
            misses: this.misses,
            idle: this.parked.length,
            target: this.target,
            supported: this.supported
        };
    }

    /**
     * Takes a warm connection for `requestId`, or returns undefined when none is ready.
     *
     * The returned socket has already been bound to the request, so the caller can use
     * it exactly as it would a freshly opened one that has just fired 'open'.
     */
    public acquire(requestId: string): WebSocket | undefined {
        this.demandSinceSweep = true;

        let connection = this.parked.pop();

        // A connection the proxy or a load balancer closed while parked is still in the
        // array until its 'close' fires; skip anything not actually usable.
        while (connection && connection.ws.readyState !== WebSocket.OPEN) {
            this.discard(connection);
            connection = this.parked.pop();
        }

        if (!connection) {
            this.misses++;
            this.grow();
            this.refill();

            return undefined;
        }

        clearInterval(connection.ping);

        if (this.parked.length === 0) {
            // Demand just met capacity, which is the signal that capacity is too small.
            this.grow();
        }

        connection.ws.removeAllListeners('close');
        connection.ws.removeAllListeners('error');

        try {
            connection.ws.send(JSON.stringify({ type: 'bind', requestId }));
        } catch {
            // Lost between the readyState check and the send; the caller falls back.
            this.misses++;
            this.refill();

            return undefined;
        }

        this.hits++;
        this.refill();

        return connection.ws;
    }

    private grow(): void {
        this.target = Math.min(this.target + 1, POOL_MAX);
    }

    private sweep(): void {
        if (!this.demandSinceSweep && this.target > 1) {
            this.target--;
        }

        this.demandSinceSweep = false;

        while (this.parked.length > this.target) {
            this.discard(this.parked.shift() as ParkedConnection);
        }

        // A quiet period is also the cheapest time to retry a path that was failing.
        this.consecutiveFailures = 0;
        this.refill();
    }

    private refill(): void {
        if (this.stopped || !this.supported || this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            return;
        }

        while (this.parked.length + this.opening < this.target) {
            this.open();
        }
    }

    private open(): void {
        const { url, options } = buildWsConnectionParams(
            this.config,
            '/__acc/dev-tunnel/data',
            {
                'x-oa-variant': `${this.config.vhost}::${this.config.variant}`,
                'x-tunnel-token': this.config.token,
                'x-tunnel-pooled': '1'
            }
        );

        const ws = new WebSocket(url, options);

        this.opening++;

        let counted = true;

        const settle = (): void => {
            if (counted) {
                counted = false;
                this.opening--;
            }
        };

        ws.on('open', () => {
            settle();

            if (this.stopped) {
                ws.close();

                return;
            }

            this.consecutiveFailures = 0;

            const ping = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.ping();
                }
            }, PARK_PING_INTERVAL_MS);

            ping.unref();

            const connection: ParkedConnection = { ws, ping };

            ws.once('close', (code) => {
                // 1008 while parked means the proxy rejected the upgrade itself: it is
                // old enough to require a request id up front. Pooling is off from here.
                if (code === 1008) {
                    this.supported = false;
                }

                clearInterval(ping);
                this.remove(connection);
            });

            ws.on('error', () => {
                clearInterval(ping);
                this.remove(connection);
            });

            this.parked.push(connection);
        });

        // A warm-up that never connects is not a request failure, so it stays out of the
        // tunnel's error stream — requests fall back to opening their own connection.
        ws.on('error', () => {
            settle();
            this.consecutiveFailures++;
        });

        ws.on('close', (code) => {
            settle();

            if (code === 1008) {
                this.supported = false;
            }
        });
    }

    private remove(connection: ParkedConnection): void {
        const index = this.parked.indexOf(connection);

        if (index !== -1) {
            this.parked.splice(index, 1);
        }
    }

    private discard(connection: ParkedConnection): void {
        clearInterval(connection.ping);
        connection.ws.removeAllListeners('close');
        connection.ws.removeAllListeners('error');
        connection.ws.on('error', () => { /* closing anyway */ });

        if (connection.ws.readyState === WebSocket.OPEN || connection.ws.readyState === WebSocket.CONNECTING) {
            connection.ws.close();
        }
    }
}
