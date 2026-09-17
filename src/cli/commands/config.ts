import { createInterface, type Interface } from 'node:readline';
import { log, logError } from '../output.js';
import { DEFAULT_HOST, DEFAULT_PORT } from '../../types.js';
import {
    loadConfig,
    setTunnel,
    removeTunnel,
    listTunnels,
    getConfigPath,
    type TunnelEntry
} from '../../config/index.js';

function prompt(rl: Interface, question: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';

    return new Promise((resolve) => {
        rl.question(`${question}${suffix}: `, (answer) => {
            resolve(answer.trim() || defaultValue || '');
        });
    });
}

// ── Commands ─────────────────────────────────────────────────────────

export async function commandSetup(): Promise<void> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
        log(`Interactive setup — configuration will be saved to ${getConfigPath()}`);
        process.stdout.write('\n');

        const token = await prompt(rl, 'JWT token');

        if (!token) {
            logError('Token is required');
            process.exit(2);
        }

        const vhost = await prompt(rl, 'Vhost (e.g. example.com)');

        if (!vhost) {
            logError('Vhost is required');
            process.exit(2);
        }

        const variant = await prompt(rl, 'Variant (e.g. DEV_1)');

        if (!variant) {
            logError('Variant is required');
            process.exit(2);
        }

        const portStr = await prompt(rl, 'Local port', String(DEFAULT_PORT));
        const port = parseInt(portStr, 10);

        if (isNaN(port) || port < 1 || port > 65535) {
            logError(`Invalid port: ${portStr}`);
            process.exit(2);
        }

        const host = await prompt(rl, 'Local host', DEFAULT_HOST);

        const useSsl = await prompt(rl, 'Use HTTPS (wss://)?', 'yes');
        const noSsl = useSsl.toLowerCase() === 'no' || useSsl.toLowerCase() === 'n';

        const entry: TunnelEntry = { token, port, host };

        if (noSsl) {
            entry.noSsl = true;
        }

        await setTunnel(vhost, variant, entry);
        log(`Saved tunnel configuration for ${vhost} ${variant}`);
    } finally {
        rl.close();
    }
}

export async function commandConfigList(): Promise<void> {
    const config = await loadConfig();
    const tunnels = listTunnels(config);

    if (tunnels.length === 0) {
        log('No tunnel configurations saved.');
        log('Run \'acc-dev-tunnel setup\' to create one.');

        return;
    }

    for (const { vhost, variant } of tunnels) {
        process.stdout.write(`${vhost} ${variant}\n`);
    }
}

export async function commandConfigGet(vhost: string | undefined, variant: string | undefined): Promise<void> {
    if (!vhost || !variant) {
        logError('Usage: acc-dev-tunnel config get <vhost> <variant>');
        process.exit(2);
    }

    const config = await loadConfig();
    const entry = config.tunnels[vhost]?.[variant];

    if (!entry) {
        logError(`No tunnel configuration found for ${vhost} ${variant}`);
        process.exit(1);
    }

    const output: Record<string, unknown> = {
        vhost,
        variant,
        token: entry.token ? `${entry.token.slice(0, 8)}...` : undefined,
        port: entry.port ?? DEFAULT_PORT,
        host: entry.host ?? DEFAULT_HOST,
        noSsl: entry.noSsl ?? false
    };

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

export async function commandConfigSet(
    vhost: string | undefined,
    variant: string | undefined,
    values: Record<string, string | boolean | undefined>
): Promise<void> {
    if (!vhost || !variant) {
        logError('Usage: acc-dev-tunnel config set <vhost> <variant> [options]');
        process.exit(2);
    }

    const token = (values.token as string) ?? undefined;
    const portStr = (values.port as string);
    const host = (values.host as string) ?? undefined;
    const noSsl = Boolean(values['no-ssl']);

    const entry: TunnelEntry = {};

    if (token) {
        entry.token = token;
    }

    if (portStr) {
        const port = parseInt(portStr, 10);

        if (isNaN(port) || port < 1 || port > 65535) {
            logError(`Invalid port: ${portStr}`);
            process.exit(2);
        }

        entry.port = port;
    }

    if (host) {
        entry.host = host;
    }

    if (noSsl) {
        entry.noSsl = true;
    }

    await setTunnel(vhost, variant, entry);
    log(`Saved tunnel configuration for ${vhost} ${variant}`);
}

export async function commandConfigRemove(vhost: string | undefined, variant: string | undefined): Promise<void> {
    if (!vhost || !variant) {
        logError('Usage: acc-dev-tunnel config remove <vhost> <variant>');
        process.exit(2);
    }

    const removed = await removeTunnel(vhost, variant);

    if (removed) {
        log(`Removed tunnel configuration for ${vhost} ${variant}`);
    } else {
        logError(`No tunnel configuration found for ${vhost} ${variant}`);
        process.exit(1);
    }
}
