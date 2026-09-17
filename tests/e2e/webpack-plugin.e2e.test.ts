import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import webpack from 'webpack';
import WebpackDevServer from 'webpack-dev-server';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import { readE2eConfig, MISSING_CONFIG_MESSAGE } from './config.js';
import { webpackPlugin } from '../../src/plugins/webpack.js';
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
const EXAMPLE_ROOT = fileURLToPath(new URL('../../examples/webpack-app', import.meta.url));

/** Fixed, because webpack's plugin has to be told the port before the server has one. */
const PORT = 8123;

/**
 * The webpack plugin, driven the way a developer drives it.
 *
 * Its hooks were described by hand until webpack became a devDependency, and nothing
 * ran the plugin against a dev server — which is where the host check lives that
 * refuses every tunnelled request unless the example asks it not to.
 */
describeE2e('webpack plugin', () => {
    const target = targetFor(cfg);

    let server: WebpackDevServer;

    beforeAll(async () => {
        const compiler = webpack({
            mode: 'development',
            context: EXAMPLE_ROOT,
            entry: './main.js',
            infrastructureLogging: { level: 'error' },
            stats: 'none',
            plugins: [
                new HtmlWebpackPlugin({ template: './index.html' }),
                new webpackPlugin({
                    token: cfg.token,
                    vhost: cfg.vhost,
                    variant: cfg.variant,
                    port: PORT,
                    proxy: cfg.primaryEndpoint,
                    noSsl: !cfg.tls,
                    ...(cfg.caFile ? { ca: readFileSync(cfg.caFile, 'utf-8') } : {})
                })
            ]
        });

        server = new WebpackDevServer({
            port: PORT,
            host: '127.0.0.1',
            // Without this every tunnelled request is answered `403 Invalid Host
            // header` by the dev server, before the application sees it.
            allowedHosts: [cfg.vhost]
        }, compiler);

        await server.start();
        await waitForTunnel(target, READY_TIMEOUT_MS, '/');
    }, READY_TIMEOUT_MS * 2);

    afterAll(async () => {
        await server?.stop();
    });

    it('serves the example page through the tunnel', async () => {
        const response = await pinnedRequest(target, { path: unique('/') });

        expect(response.statusCode).toBe(200);
        expect(response.body.toString()).toContain('Served from a laptop');
    }, TEST_TIMEOUT_MS);

    it('serves the bundle the page asks for', async () => {
        const response = await pinnedRequest(target, { path: unique('/main.js') });

        expect(response.statusCode).toBe(200);
        expect(response.body.toString()).toContain('dev tunnel');
    }, TEST_TIMEOUT_MS);
});
