import { readFile } from 'node:fs/promises';
import { createTunnel } from '../../index.js';
import { DEFAULT_HOST, DEFAULT_PORT } from '../../types.js';
import { loadConfig, getConfigPath } from '../../config/index.js';
import { log, logError } from '../output.js';
import { isListening } from '../probe.js';
import { describeStartupError } from '../errors.js';
import { checkToken, type CheckResult } from '../diagnostics.js';
import { resolveTarget } from './start.js';

function renderCheck(result: CheckResult): void {
    const mark = result.ok ? '\u2713' : '\u2717';
    const line = `  ${mark} ${result.label.padEnd(14)} ${result.detail}`;

    if (result.ok) {
        log(line);
    } else {
        logError(line);
    }
}

/** The only check that proves anything: bring a tunnel up, then take it down. */
async function checkTunnel(options: {
    token: string;
    vhost: string;
    variant: string;
    host: string;
    port: number;
    proxy: string | undefined;
    values: Record<string, string | boolean | undefined>;
}): Promise<CheckResult> {
    const { token, vhost, variant, host, port, proxy, values } = options;
    const caPath = values.ca as string | undefined;

    let ca: string | undefined;

    if (caPath) {
        try {
            ca = await readFile(caPath, 'utf-8');
        } catch (err) {
            return {
                ok: false,
                label: 'accelerator',
                detail: `cannot read ${caPath}: ${err instanceof Error ? err.message : String(err)}`
            };
        }
    }

    try {
        const tunnel = await createTunnel({
            token,
            vhost,
            variant,
            host,
            port,
            proxy,
            noSsl: Boolean(values['no-ssl']),
            ca,
            insecureTls: Boolean(values['insecure-tls']),
            maxReconnectAttempts: 1
        });

        await tunnel.stop();

        return { ok: true, label: 'accelerator', detail: `tunnel established via ${proxy ?? vhost}` };
    } catch (err) {
        return { ok: false, label: 'accelerator', detail: describeStartupError(err, vhost, proxy) };
    }
}

/**
 * Tell the developer which part is broken, rather than making them bisect it.
 *
 * Everything here is something this client can establish on its own: a saved
 * configuration, what the token says about itself, whether the local application
 * answers, and whether a tunnel actually comes up. The last is the only real proof, and
 * also the one nobody can run by hand without starting a tunnel and reading the output.
 */
export async function commandCheck(
    vhostArg: string | undefined,
    variantArg: string | undefined,
    values: Record<string, string | boolean | undefined>
): Promise<void> {
    const config = await loadConfig();
    const { vhost, variant } = resolveTarget(vhostArg, variantArg, config);
    const entry = config.tunnels[vhost]?.[variant];
    const results: CheckResult[] = [];

    const token = (values.token as string | undefined) ?? process.env.ACC_DEV_TUNNEL_TOKEN ?? entry?.token;

    log(`checking ${vhost}::${variant}`);

    const host = (values.host as string | undefined) ?? entry?.host ?? DEFAULT_HOST;
    const port = Number(values.port ?? entry?.port ?? DEFAULT_PORT);
    const proxy = (values.proxy as string | undefined) ?? process.env.ACC_DEV_TUNNEL_PROXY;

    if (entry) {
        results.push({ ok: true, label: 'configuration', detail: getConfigPath() });
    } else if (token) {
        // Nothing saved, but a token was supplied — a perfectly good way to run this,
        // and reporting it as a fault would send someone to fix what is not broken.
        results.push({ ok: true, label: 'configuration', detail: 'none saved; using the token you passed' });
    } else {
        results.push({
            ok: false,
            label: 'configuration',
            detail: `nothing saved for ${vhost} ${variant} — run "acc-dev-tunnel setup"`
        });
    }

    if (token) {
        results.push(checkToken(token, vhost, variant));
    } else {
        results.push({
            ok: false,
            label: 'token',
            detail: 'missing — set ACC_DEV_TUNNEL_TOKEN or save one with "config set"'
        });
    }

    const listening = await isListening(host, port);

    results.push(listening
        ? { ok: true, label: 'local app', detail: `answering on ${host}:${port}` }
        : {
            ok: false,
            label: 'local app',
            detail: `nothing listening on ${host}:${port} — start it, or pass --port`
        });

    results.push(token
        ? await checkTunnel({ token, vhost, variant, host, port, proxy, values })
        : { ok: false, label: 'accelerator', detail: 'skipped, no token to connect with' });

    for (const result of results) {
        renderCheck(result);
    }

    const failed = results.filter((result) => !result.ok).length;

    if (failed === 0) {
        log('everything checks out — "acc-dev-tunnel start" should work');
        log(`remember that ${variant} only receives traffic you force to it`);

        return;
    }

    logError(`${failed} problem${failed === 1 ? '' : 's'} found`);
    process.exit(1);
}
