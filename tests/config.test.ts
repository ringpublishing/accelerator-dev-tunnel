import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, stat, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

vi.mock('node:os', async (importOriginal): Promise<typeof import('node:os')> => {
    const actual = await importOriginal<typeof import('node:os')>();

    return { ...actual, homedir: (): string => home };
});

function importConfig(): Promise<typeof import('../src/config/index.js')> {
    vi.resetModules();

    return import('../src/config/index.js');
}

describe('config storage', () => {
    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'acc-dev-tunnel-test-'));
    });

    afterEach(async () => {
        await rm(home, { recursive: true, force: true });
    });

    it('should return an empty config when none exists yet', async () => {
        const { loadConfig } = await importConfig();

        expect(await loadConfig()).toEqual({ tunnels: {} });
    });

    it('should store the token owner-only, since the file holds a JWT', async () => {
        const { setTunnel, getConfigPath } = await importConfig();

        await setTunnel('example.com', 'DEV_1', { token: 'jwt-value', port: 3000 });

        const fileMode = (await stat(getConfigPath())).mode & 0o777;
        const dirMode = (await stat(join(home, '.ring'))).mode & 0o777;

        expect(fileMode).toBe(0o600);
        expect(dirMode).toBe(0o700);
    });

    it('should round-trip a stored tunnel', async () => {
        const { setTunnel, loadConfig } = await importConfig();

        await setTunnel('example.com', 'DEV_1', { token: 'jwt-value', port: 3000 });

        expect((await loadConfig()).tunnels['example.com']?.DEV_1).toEqual({ token: 'jwt-value', port: 3000 });
    });

    it('should surface corrupt JSON instead of reporting an empty config', async () => {
        const { loadConfig, getConfigPath } = await importConfig();

        await mkdir(join(home, '.ring'), { recursive: true });
        await writeFile(getConfigPath(), '{ not json');

        // Swallowing this told the user their token was missing right after they saved it.
        await expect(loadConfig()).rejects.toThrow(/not valid JSON/);
    });

    it.each(['{"tunnels": null}', '{"tunnels": []}', '[]', '"nope"'])(
        'should reject a config whose shape is wrong: %s',
        async (contents) => {
            const { loadConfig, getConfigPath } = await importConfig();

            await mkdir(join(home, '.ring'), { recursive: true });
            await writeFile(getConfigPath(), contents);

            // An array passes a bare `typeof === 'object'` check and would only fail
            // later, somewhere with far less context.
            await expect(loadConfig()).rejects.toThrow(/expected shape/);
        }
    );

    it('should not leave a temp file behind after a write', async () => {
        const { setTunnel } = await importConfig();

        await setTunnel('example.com', 'DEV_1', { token: 'jwt-value' });

        const { readdir } = await import('node:fs/promises');
        const entries = await readdir(join(home, '.ring'));

        expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('should remove a tunnel and prune the empty vhost', async () => {
        const { setTunnel, removeTunnel, getConfigPath } = await importConfig();

        await setTunnel('example.com', 'DEV_1', { token: 'jwt-value' });

        expect(await removeTunnel('example.com', 'DEV_1')).toBe(true);
        expect(JSON.parse(await readFile(getConfigPath(), 'utf-8'))).toEqual({ tunnels: {} });
    });
});
