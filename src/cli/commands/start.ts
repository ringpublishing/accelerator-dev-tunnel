import { readFile } from 'node:fs/promises';
import { createTunnel, formatRequestLine } from '../../index.js';
import { AuthError, TakeoverError, MissingParamError } from '../../errors.js';
import {
    type Tunnel,
    reconnectDelayFor,
    DEFAULT_IDLE_TIMEOUT,
    MAX_IDLE_TIMEOUT,
    DEFAULT_PORT,
    DEFAULT_HOST
} from '../../types.js';
import { loadConfig, listTunnels, type Config } from '../../config/index.js';
import { log, logError } from '../output.js';
import { warnIfNothingIsListening } from '../probe.js';
import { describeStartupError } from '../errors.js';
import { humanizeDuration } from '../diagnostics.js';

/** Ctrl-C must end the process even if a graceful stop hangs. */
const FORCE_EXIT_TIMEOUT_MS = 3_000;

/**
 * How often to say the tunnel is still there.
 *
 * A tunnel carrying no traffic prints nothing, which looks exactly like one that died
 * an hour ago — and a developer who cannot tell the difference restarts it to find out.
 */
const STATUS_INTERVAL_MS = 60_000;

/**
 * Work out which tunnel to start.
 *
 * With one saved configuration there is nothing to disambiguate, so requiring the
 * arguments only makes people look up what they already told us.
 */
export function resolveTarget(
    vhost: string | undefined,
    variant: string | undefined,
    config: Config
): { vhost: string; variant: string; } {
    if (vhost && variant) {
        return { vhost, variant };
    }

    if (vhost && !variant) {
        logError('Usage: acc-dev-tunnel start <vhost> <variant>');
        process.exit(2);
    }

    const saved = listTunnels(config);

    if (saved.length === 1) {
        const only = saved[0] as { vhost: string; variant: string; };

        log(`using the only saved configuration: ${only.vhost} ${only.variant}`);

        return only;
    }

    if (saved.length === 0) {
        logError('No vhost and variant given, and nothing is saved.');
        logError('Run "acc-dev-tunnel setup", or pass them: acc-dev-tunnel start <vhost> <variant>');
        process.exit(2);
    }

    logError('No vhost and variant given, and more than one configuration is saved:');

    for (const entry of saved) {
        logError(`  ${entry.vhost} ${entry.variant}`);
    }

    process.exit(2);
}

export async function commandStart(
    vhostArg: string | undefined,
    variantArg: string | undefined,
    values: Record<string, string | boolean | undefined>
): Promise<void> {
    const config = await loadConfig();
    const { vhost, variant } = resolveTarget(vhostArg, variantArg, config);
    const configEntry = config.tunnels[vhost]?.[variant];

    // Flags win over the config file, which wins over the defaults.
    const token = (values.token as string | undefined)
        ?? process.env.ACC_DEV_TUNNEL_TOKEN
        ?? configEntry?.token;
    const portStr = values.port as string | undefined;
    const host = (values.host as string | undefined) ?? configEntry?.host ?? DEFAULT_HOST;
    const noSsl = (values['no-ssl'] as boolean | undefined) ?? configEntry?.noSsl ?? false;

    let port = configEntry?.port ?? DEFAULT_PORT;

    if (portStr !== undefined) {
        const parsed = Number(portStr);

        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
            logError(`Invalid port: ${portStr} (must be 1-65535)`);
            process.exit(2);
        }

        port = parsed;
    }

    // Runtime-only flags
    const idleTimeoutStr = values['idle-timeout'] as string | undefined;
    const proxy = (values.proxy as string) ?? process.env.ACC_DEV_TUNNEL_PROXY;

    if (noSsl) {
        logError('warning: --no-ssl sends your token in cleartext on every connection');
    }

    const caPath = values.ca as string | undefined;
    const insecureTls = (values['insecure-tls'] as boolean | undefined) ?? false;

    if (insecureTls && caPath) {
        logError('--insecure-tls and --ca cannot be combined: turning verification off makes a trusted certificate meaningless');
        process.exit(2);
    }

    let ca: string | undefined;

    if (caPath) {
        try {
            ca = await readFile(caPath, 'utf-8');
        } catch (err) {
            logError(`Cannot read certificate from ${caPath}: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(2);
        }
    }

    if (insecureTls) {
        logError('warning: --insecure-tls disables certificate verification entirely — not just for self-signed certificates');
        logError('         prefer --ca <file>, which trusts one certificate and keeps every other check');
    }

    if (!token) {
        logError('Missing token. Set ACC_DEV_TUNNEL_TOKEN or run "acc-dev-tunnel config set" with --token.');
        process.exit(2);
    }

    const idleTimeout = idleTimeoutStr ? parseInt(idleTimeoutStr, 10) : undefined;

    if (idleTimeout !== undefined && (isNaN(idleTimeout) || idleTimeout < 1 || idleTimeout > MAX_IDLE_TIMEOUT)) {
        logError(`Invalid idle-timeout: ${idleTimeoutStr} (must be 1-${MAX_IDLE_TIMEOUT})`);
        process.exit(2);
    }

    let activeTunnel: Tunnel | undefined;
    let shuttingDown = false;

    const gracefulShutdown = async (): Promise<void> => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        log('shutting down...');

        // If stop() ever hangs, Ctrl-C must still end the process.
        const forceExit = setTimeout(() => process.exit(0), FORCE_EXIT_TIMEOUT_MS);

        forceExit.unref();

        await activeTunnel?.stop();
        process.exit(0);
    };

    // Registered before connecting: a connect can take a while, and Ctrl-C during it
    // should behave the same as Ctrl-C afterwards.
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);

    await warnIfNothingIsListening(host, port);

    try {
        const tunnel = await createTunnel({
            token,
            vhost,
            variant,
            port,
            host,
            idleTimeout,
            proxy: proxy as string | undefined,
            noSsl,
            ca,
            insecureTls
        });

        activeTunnel = tunnel;

        const proxyInfo = proxy ? ` via proxy ${proxy}` : '';

        log(`connected to ${vhost}::${variant}${proxyInfo}`);
        // Without this nothing happens next and nothing says why: a development variant
        // is never in traffic, so the tunnel sits idle until someone asks for it.
        log(`no traffic reaches ${variant} until you ask for it:`);
        log('  browser — "Force as current for me" in the Accelerator panel, or the bookmarklet');
        log(`  backend — send the header  x-oa-variant: ${vhost}::${variant}`);

        const startedAt = Date.now();
        let requestCount = 0;
        let lastRequestAt = 0;

        // Logged on the response, not the request: a line that cannot tell a 200 from a
        // 502 makes the developer open the browser to find out what their own tunnel did.
        tunnel.on('response', (info) => {
            requestCount++;
            lastRequestAt = Date.now();
            log(formatRequestLine(info));
        });

        const statusTimer = setInterval(() => {
            const traffic = requestCount === 0
                ? 'no requests yet'
                : `${requestCount} request${requestCount === 1 ? '' : 's'}, last ${humanizeDuration(Date.now() - lastRequestAt)} ago`;

            log(`still connected · up ${humanizeDuration(Date.now() - startedAt)} · ${traffic}`);
        }, STATUS_INTERVAL_MS);

        // Never the reason the process stays alive; the tunnel itself is.
        statusTimer.unref();

        tunnel.on('reconnect', (attempt) => {
            const delaySec = reconnectDelayFor(attempt) / 1000;

            logError(`control connection lost, reconnecting in ${delaySec}s... (attempt ${attempt})`);
        });

        tunnel.on('connect', () => {
            log('control connection re-established');
        });

        tunnel.on('disconnect', (reason) => {
            if (reason === 'idle_timeout') {
                log(`idle timeout reached (${idleTimeout ?? DEFAULT_IDLE_TIMEOUT}s), exiting`);
                process.exit(0);
            }

            if (reason === 'shutdown') {
                log('server requested shutdown, exiting');
                process.exit(0);
            }

            if (reason === 'auth_error') {
                logError('authentication failed, exiting');
                logError('Run "acc-dev-tunnel setup" to store a new token, or rotate it in the Accelerator panel.');
                process.exit(1);
            }

            if (reason === 'replaced') {
                // Not an auth failure: this token is fine, someone else claimed the variant.
                logError(`another client connected to ${vhost}::${variant} and took over the tunnel, exiting`);
                process.exit(1);
            }

            if (reason === 'rejected' || reason === 'reconnect_exhausted') {
                logError('connection cannot be re-established, exiting');
                process.exit(1);
            }
        });

        tunnel.on('error', (err) => {
            logError(err.message);

            if (err instanceof AuthError) {
                process.exit(1);
            }
        });
    } catch (err) {
        if (err instanceof TakeoverError) {
            logError(err.message);
            process.exit(1);
        }

        if (err instanceof AuthError) {
            logError(err.message);
            logError('Run "acc-dev-tunnel setup" to store a new token, or rotate it in the Accelerator panel.');
            process.exit(1);
        }

        if (err instanceof MissingParamError) {
            logError(err.message);
            process.exit(2);
        }

        logError(describeStartupError(err, vhost, proxy));
        process.exit(1);
    }
}
