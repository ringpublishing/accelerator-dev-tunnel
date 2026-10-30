import {
    type TunnelOptions,
    type ResolvedConfig,
    type Tunnel,
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_IDLE_TIMEOUT,
    MAX_IDLE_TIMEOUT
} from './types.js';
import {
    MissingParamError
} from './errors.js';
import {
    TunnelEmitter
} from './emitter.js';

export { formatTimestamp, formatRequestLine } from './format.js';
import { startControl } from './tunnel/control.js';
import { DataConnectionPool } from './tunnel/pool.js';

export type {
    Tunnel,
    TunnelOptions,
    TunnelEvents,
    RequestInfo,
    ResponseInfo,
    ResolvedConfig,
    DisconnectReason
} from './types.js';
// Consumers are told to branch on `err instanceof AuthError`; without exporting the
// classes there is no way for them to do that.
export { AuthError, TakeoverError, MissingParamError } from './errors.js';
export { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_IDLE_TIMEOUT, MAX_IDLE_TIMEOUT } from './types.js';

/**
 * Create a dev-tunnel connection to Ring Accelerator.
 *
 * Resolves once the control connection is established and authenticated.
 * Rejects immediately on auth errors.
 */
export async function createTunnel(options: TunnelOptions): Promise<Tunnel> {
    const config = resolveConfig(options);
    const tunnel = new TunnelEmitter();
    const ac = new AbortController();
    const pool = new DataConnectionPool(config);

    tunnel._setStopFn(() => {
        pool.stop();
        ac.abort();
    });

    tunnel._setStatsFn(() => ({ pool: pool.stats() }));

    await startControl(config, tunnel, ac.signal, pool);

    return tunnel;
}

/**
 * Normalise and validate options.
 *
 * Exported so validation can be tested without opening a socket. It is reachable from
 * the package root, but it is not part of the supported API and is not covered by
 * semver — do not depend on it.
 */
export function resolveConfig(options: TunnelOptions): ResolvedConfig {
    if (!options.token) {
        throw new MissingParamError('token');
    }

    if (!options.vhost) {
        throw new MissingParamError('vhost');
    }

    if (!options.variant) {
        throw new MissingParamError('variant');
    }

    if (options.port === undefined && options.host === undefined) {
        throw new MissingParamError('host or port (at least one must be provided)');
    }

    const port = options.port ?? DEFAULT_PORT;

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new TypeError(`Invalid port: ${port} (must be 1-65535)`);
    }

    const rawIdleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;

    if (!Number.isFinite(rawIdleTimeout)) {
        throw new TypeError('idleTimeout must be a finite number');
    }

    const idleTimeout = Math.round(rawIdleTimeout);

    if (idleTimeout < 1 || idleTimeout > MAX_IDLE_TIMEOUT) {
        throw new TypeError(`Invalid idleTimeout: ${rawIdleTimeout} (must be 1-${MAX_IDLE_TIMEOUT} seconds)`);
    }

    const maxReconnectAttempts = options.maxReconnectAttempts ?? 0;

    if (!Number.isInteger(maxReconnectAttempts) || maxReconnectAttempts < 0) {
        throw new TypeError(`Invalid maxReconnectAttempts: ${maxReconnectAttempts} (must be 0 or a positive integer)`);
    }

    const noSsl = options.noSsl ?? false;
    const proxy = parseProxy(options.proxy, noSsl);
    const insecureTls = options.insecureTls ?? false;

    if (insecureTls && options.ca) {
        throw new TypeError('insecureTls and ca are mutually exclusive: turning verification off makes a trusted certificate meaningless');
    }

    return {
        token: options.token,
        vhost: options.vhost,
        variant: options.variant,
        port,
        host: options.host ?? DEFAULT_HOST,
        idleTimeout,
        proxy,
        noSsl,
        ca: options.ca,
        insecureTls,
        maxReconnectAttempts
    };
}

/**
 * Split `host` or `host:port` into its parts.
 *
 * Exported so its edge cases are testable. It is reachable from the package root, but
 * it is not part of the supported API and is not covered by semver — do not depend
 * on it.
 *
 * A trailing `:something` that is not a valid port is an error, not a hostname. Folding
 * it back into the host produced URLs like `wss://example.com:99999:443/...`, which
 * surfaced to the developer as an opaque ERR_INVALID_URL with nothing pointing at the
 * port they mistyped.
 */
export function parseProxy(proxy: string | undefined, noSsl: boolean): { host: string; port: number; } | undefined {
    if (!proxy) {
        return undefined;
    }

    const defaultPort = noSsl ? 80 : 443;

    // Bracketed IPv6, optionally with a port: [::1] or [::1]:8080
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(proxy);

    if (bracketed?.[1]) {
        const bracketPort = bracketed[2];

        return { host: bracketed[1], port: bracketPort ? parsePort(bracketPort, proxy) : defaultPort };
    }

    // A bare IPv6 address has several colons and no port; anything with one colon is host:port.
    if (proxy.indexOf(':') !== proxy.lastIndexOf(':')) {
        return { host: proxy, port: defaultPort };
    }

    const lastColon = proxy.lastIndexOf(':');

    if (lastColon === -1) {
        return { host: proxy, port: defaultPort };
    }

    if (lastColon === 0) {
        throw new TypeError(`Invalid proxy "${proxy}": missing host before the port`);
    }

    return { host: proxy.slice(0, lastColon), port: parsePort(proxy.slice(lastColon + 1), proxy) };
}

function parsePort(portStr: string, proxy: string): number {
    const port = Number(portStr);

    if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== portStr) {
        throw new TypeError(`Invalid proxy "${proxy}": "${portStr}" is not a port between 1 and 65535`);
    }

    return port;
}
