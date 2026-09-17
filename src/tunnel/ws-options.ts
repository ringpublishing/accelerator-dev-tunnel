import type { ClientOptions } from 'ws';
import type {
    ResolvedConfig
} from '../types.js';

/**
 * ws passes unrecognised options straight through to tls.connect(), which is how SNI
 * is set — but `servername` is not part of its declared ClientOptions, so it has to be
 * spelled out here rather than silently dropped by the type checker.
 */
export type WsClientOptions = ClientOptions & {
    servername?: string;
    ca?: string | string[];
    rejectUnauthorized?: boolean;
};

export interface WsConnectionParams {
    url: string;
    options: WsClientOptions;
}

/**
 * Builds WebSocket URL and connection options based on config.
 *
 * With a proxy configured the TCP connection goes to the proxy while `Host` and the
 * TLS SNI still name the vhost — so the tunnel reaches Accelerator through a given
 * address rather than through whatever the vhost resolves to.
 */
export function buildWsConnectionParams(
    config: ResolvedConfig,
    path: string,
    extraHeaders?: Record<string, string>
): WsConnectionParams {
    const protocol = config.noSsl ? 'ws' : 'wss';
    const targetHost = config.proxy
        ? `${config.proxy.host}:${config.proxy.port}`
        : config.vhost;

    const url = `${protocol}://${targetHost}${path}`;

    const headers: Record<string, string> = {
        ...extraHeaders
    };

    const options: WsClientOptions = { headers };

    if (config.proxy) {
        headers.Host = config.vhost;

        if (!config.noSsl) {
            options.servername = config.vhost;
        }
    }

    if (!config.noSsl) {
        // Trusting an extra certificate keeps hostname, expiry and chain checks in
        // place; turning verification off keeps none of them.
        if (config.ca) {
            options.ca = config.ca;
        }

        if (config.insecureTls) {
            options.rejectUnauthorized = false;
        }
    }

    return { url, options };
}
