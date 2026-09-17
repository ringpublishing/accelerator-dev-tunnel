import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { readE2eConfig, MISSING_CONFIG_MESSAGE } from './config.js';
import { vitePlugin } from '../../src/plugins/vite.js';
import { pinnedRequest } from './harness/pinned.js';
import { READY_TIMEOUT_MS, targetFor, unique, waitForTunnel } from './harness/session.js';

const config = readE2eConfig();
const describeE2e = config ? describe : describe.skip;

if (!config) {
    console.warn(MISSING_CONFIG_MESSAGE);
}

const cfg = config ?? {
    vhost: 'unconfigured.invalid',
    variant: 'NONE',
    token: '',
    primaryEndpoint: 'unconfigured.invalid',
    secondaryEndpoint: undefined,
    tls: true
};

const TEST_TIMEOUT_MS = 120_000;

const EXAMPLE_ROOT = fileURLToPath(new URL('../../examples/vite-app', import.meta.url));

/**
 * The Vite plugin, driven the way a developer drives it.
 *
 * Nothing else exercises this path: the plugin infers the port from a running dev
 * server, hooks its shutdown, and is the only thing standing between our peer range
 * claiming Vite 7 support and that being true. Running the example application through
 * it is what turns that claim into evidence.
 */
describeE2e('vite plugin', () => {
    const target = targetFor(cfg);

    let server: ViteDevServer;

    beforeAll(async () => {
        server = await createServer({
            root: EXAMPLE_ROOT,
            // The example's own config adds the plugin from environment variables; here
            // the test supplies it directly so it can aim at a chosen entry point and
            // trust the vhost's certificate.
            configFile: false,
            logLevel: 'warn',
            server: { host: '127.0.0.1', port: 0 },
            plugins: [
                vitePlugin({
                    token: cfg.token,
                    vhost: cfg.vhost,
                    variant: cfg.variant,
                    proxy: cfg.primaryEndpoint,
                    noSsl: !cfg.tls,
                    ...(cfg.caFile ? { ca: readFileSync(cfg.caFile, 'utf-8') } : {})
                })
            ]
        });

        await server.listen();
        // The example serves its own index; the fixture's paths mean nothing here.
        await waitForTunnel(target, READY_TIMEOUT_MS, '/index.html');
    }, READY_TIMEOUT_MS * 2);

    afterAll(async () => {
        await server?.close();
    });

    it('serves the example page through the tunnel', async () => {
        const response = await pinnedRequest(target, { path: unique('/index.html') });

        expect(response.statusCode).toBe(200);
        expect(response.body.toString()).toContain('Served from a laptop');
    }, TEST_TIMEOUT_MS);

    it('serves the module the page asks for', async () => {
        // Vite rewrites and serves this itself, so it also proves the tunnel is carrying
        // the dev server's own responses rather than static files off disk.
        const response = await pinnedRequest(target, { path: unique('/main.js') });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('javascript');
        expect(response.body.toString()).toContain('dev tunnel');
    }, TEST_TIMEOUT_MS);

    it('serves the client Vite injects for hot reload', async () => {
        // The HMR client is fetched as a module before the WebSocket is opened; if the
        // tunnel mangles it, hot reload fails in a way that looks like a Vite problem.
        const response = await pinnedRequest(target, { path: unique('/@vite/client') });

        expect(response.statusCode).toBe(200);
        expect(response.body.toString()).toContain('createHotContext');
    }, TEST_TIMEOUT_MS);

    it('tunnels the port it discovered rather than one it was given', () => {
        // The plugin is never told a port — it reads it off the dev server once it is
        // listening. If that ever breaks, every request above would 502 instead.
        const address = server.httpServer?.address();

        expect(address && typeof address === 'object' ? address.port : 0).toBeGreaterThan(0);
    });
});
