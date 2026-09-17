import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';

const CONFIG_DIR = join(homedir(), '.ring');
const CONFIG_FILE = join(CONFIG_DIR, 'accelerator-dev-tunnel.json');

/** This file holds JWTs. Owner-only, on a machine that may well be shared. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface TunnelEntry {
    token?: string;
    port?: number;
    host?: string;
    noSsl?: boolean;
}

export interface Config {
    /** tunnels[vhost][variant] = entry */
    tunnels: Record<string, Record<string, TunnelEntry>>;
}

export function getConfigPath(): string {
    return CONFIG_FILE;
}

export async function loadConfig(): Promise<Config> {
    let raw: string;

    try {
        raw = await readFile(CONFIG_FILE, 'utf-8');
    } catch (err) {
        // "No config yet" is normal. Anything else — a permissions problem, a
        // directory where the file should be — must not masquerade as an empty
        // config, or the user is told their token is missing right after saving it.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { tunnels: {} };
        }

        throw err;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`Config file at ${CONFIG_FILE} is not valid JSON`);
    }

    // Arrays are objects, so `{"tunnels": []}` would slip through a bare typeof check
    // and only fail later, somewhere less obvious.
    const tunnels = (parsed as Config | null)?.tunnels;

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || typeof tunnels !== 'object' || tunnels === null || Array.isArray(tunnels)) {
        throw new Error(`Config file at ${CONFIG_FILE} does not have the expected shape`);
    }

    return parsed as Config;
}

export async function saveConfig(config: Config): Promise<void> {
    await mkdir(CONFIG_DIR, { recursive: true, mode: DIR_MODE });
    // mkdir's mode is ignored when the directory already exists, so tighten it either way.
    await chmod(CONFIG_DIR, DIR_MODE);

    // Write to a sibling and rename, so an interrupted write cannot leave a truncated
    // config behind and lose every saved tunnel.
    const tempFile = `${CONFIG_FILE}.${process.pid}.tmp`;

    await writeFile(tempFile, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf-8', mode: FILE_MODE });
    await rename(tempFile, CONFIG_FILE);
}

export async function setTunnel(vhost: string, variant: string, entry: TunnelEntry): Promise<void> {
    const config = await loadConfig();

    if (!config.tunnels[vhost]) {
        config.tunnels[vhost] = {};
    }

    config.tunnels[vhost][variant] = entry;

    await saveConfig(config);
}

export async function removeTunnel(vhost: string, variant: string): Promise<boolean> {
    const config = await loadConfig();

    if (!config.tunnels[vhost] || !(variant in config.tunnels[vhost])) {
        return false;
    }

    delete config.tunnels[vhost][variant];

    // Clean up empty vhost object
    if (Object.keys(config.tunnels[vhost]).length === 0) {
        delete config.tunnels[vhost];
    }

    await saveConfig(config);

    return true;
}

export function listTunnels(config: Config): Array<{ vhost: string; variant: string; }> {
    const result: Array<{ vhost: string; variant: string; }> = [];

    for (const [vhost, variants] of Object.entries(config.tunnels)) {
        for (const variant of Object.keys(variants)) {
            result.push({ vhost, variant });
        }
    }

    return result;
}
