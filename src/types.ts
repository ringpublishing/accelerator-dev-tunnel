export interface TunnelOptions {
    /** JWT token for authentication */
    token: string;
    /** Accelerator vhost (e.g. example.com) */
    vhost: string;
    /** Variant name (e.g. DEV_1) */
    variant: string;
    /** Local port to forward traffic to (default: 80). At least one of port/host must be provided. */
    port?: number;
    /** Local host to forward traffic to (default: 127.0.0.1). At least one of port/host must be provided. */
    host?: string;
    /** Seconds of inactivity before exit (default: 14400, max: 86400) */
    idleTimeout?: number;
    /** Connect via proxy instead of directly to vhost. Format: <host> or <host>:<port> */
    proxy?: string;
    /** Disable TLS — use ws:// instead of wss:// (default: false) */
    noSsl?: boolean;
    /**
     * Extra certificate authorities to trust, as PEM.
     *
     * The right answer for a development vhost carrying a self-signed certificate:
     * verification stays on, this certificate is simply trusted. Accepts the
     * self-signed certificate itself, since such a certificate is its own issuer.
     */
    ca?: string | string[];
    /**
     * Turn off TLS verification entirely (default: false).
     *
     * Not "accept self-signed" — it also accepts an expired certificate, one issued
     * for a different host, and one presented by whoever is between you and the vhost.
     * Prefer `ca`, which keeps every one of those checks.
     */
    insecureTls?: boolean;
    /**
     * Give up after this many consecutive reconnect attempts (default: 0, meaning
     * never give up). A laptop left overnight against a decommissioned proxy would
     * otherwise retry forever.
     */
    maxReconnectAttempts?: number;
}

export interface RequestInfo {
    method: string;
    path: string;
    remoteIp: string;
}

export type DisconnectReason =
    | 'idle_timeout'
    | 'shutdown'
    | 'auth_error'
    /** Another client connected to the same variant and took the tunnel over. */
    | 'replaced'
    /** The server closed with a code that will not succeed on retry. */
    | 'rejected'
    /** maxReconnectAttempts was reached. */
    | 'reconnect_exhausted'
    | 'stopped';

export interface TunnelEvents {
    connect: [];
    disconnect: [reason: DisconnectReason];
    reconnect: [attempt: number];
    request: [info: RequestInfo];
    response: [info: ResponseInfo];
    error: [err: Error];
}

/**
 * How a tunnelled request ended.
 *
 * Emitted for every request the tunnel carries, including the ones the local
 * application never answered — a request that silently produces no line at all is
 * exactly the case someone watching the terminal needs to see.
 */
export interface ResponseInfo {
    method: string;
    path: string;
    remoteIp: string;
    /**
     * Status the local application returned.
     *
     * `502` is this client's own answer when the application could not be reached,
     * `101` a WebSocket that was accepted, and `0` a request whose connection ended
     * before any response head arrived.
     */
    statusCode: number;
    /** Milliseconds from being asked for the request to its head coming back. */
    durationMs: number;
}

export interface PoolStats {
    /** Requests served by a connection that was already established. */
    hits: number;
    /** Requests that found the pool empty and had to open their own connection. */
    misses: number;
    /** Connections warm right now. */
    idle: number;
    /** How many connections the pool is currently trying to keep warm. */
    target: number;
    /** False once the proxy has told us it does not understand pooled connections. */
    supported: boolean;
}

export interface TunnelStats {
    /** Data-connection pool counters, for diagnosing latency and pool behaviour. */
    pool: PoolStats;
}

export interface Tunnel {
    on<E extends keyof TunnelEvents>(event: E, listener: (...args: TunnelEvents[E]) => void): this;
    emit<E extends keyof TunnelEvents>(event: E, ...args: TunnelEvents[E]): boolean;
    off<E extends keyof TunnelEvents>(event: E, listener: (...args: TunnelEvents[E]) => void): this;
    stop(): Promise<void>;
    /** A snapshot of the tunnel's internal counters. Diagnostics only, not semver-stable. */
    stats(): TunnelStats;
}

// ── Control protocol messages ────────────────────────────────────────

export interface ResolvedConfig {
    token: string;
    vhost: string;
    variant: string;
    port: number;
    host: string;
    idleTimeout: number;
    proxy: { host: string; port: number; } | undefined;
    noSsl: boolean;
    ca: string | string[] | undefined;
    insecureTls: boolean;
    /** 0 means retry indefinitely. */
    maxReconnectAttempts: number;
}

// ── Auth error ───────────────────────────────────────────────────────

export const MAX_IDLE_TIMEOUT = 86400;
export const DEFAULT_IDLE_TIMEOUT = 14400;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 80;

export const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000] as const;

/** Backoff delay for a 1-based attempt number, held at the last value once exhausted. */
export function reconnectDelayFor(attempt: number): number {
    const index = Math.min(Math.max(attempt, 1) - 1, RECONNECT_DELAYS.length - 1);

    return RECONNECT_DELAYS[index] ?? RECONNECT_DELAYS[RECONNECT_DELAYS.length - 1] ?? 1000;
}

/** ±20% spread on each reconnect delay, so a proxy restart is not met by a stampede. */
export const RECONNECT_JITTER = 0.2;

/**
 * WebSocket close codes that mean retrying is pointless.
 *
 * 1008 covers the proxy's auth_timeout, invalid_message and token rejections — and
 * auth_timeout arrives with no auth_error frame at all, so the code is the only signal.
 */
export const TERMINAL_CLOSE_CODES: readonly number[] = [1002, 1003, 1008];

/**
 * Give up on the control connection if no pong arrives within this window.
 *
 * The proxy pings every 20s. A half-open TCP — laptop sleep, VPN drop, NAT rebind —
 * otherwise leaves the client believing it is connected until the OS gives up, while
 * every request 502s on the other side.
 */
export const CONTROL_LIVENESS_TIMEOUT_MS = 60_000;
