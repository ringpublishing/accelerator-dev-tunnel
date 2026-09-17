import { describe, it, expect } from 'vitest';
import webpack from 'webpack';
import { webpackPlugin } from '../../src/plugins/webpack.js';

const OPTIONS = { token: 'test-token', vhost: 'example.com', variant: 'DEV_1', port: 8080 };

/** A compiler, not a build: creating one is enough to see the hooks it really has. */
function createCompiler(): webpack.Compiler {
    return webpack({ entry: { main: '/dev/null' }, output: { path: '/tmp' } });
}

describe('webpackPlugin', () => {
    it('taps the hooks it thinks webpack has', async () => {
        // These were described by hand until webpack became a devDependency, so nothing
        // checked that `afterEmit` and `shutdown` exist or that they take a promise.
        // A wrong guess passed the type check and failed at the first build.
        const compiler = createCompiler();

        new webpackPlugin(OPTIONS).apply(compiler);

        expect(compiler.hooks.afterEmit.taps.map((tap) => tap.name)).toContain(webpackPlugin.pluginName);
        expect(compiler.hooks.shutdown.taps.map((tap) => tap.name)).toContain(webpackPlugin.pluginName);

        await new Promise<void>((resolve) => compiler.close(() => resolve()));
    });

    it('shuts down cleanly when no tunnel was ever started', async () => {
        // The shutdown hook fires whether or not the build got far enough to connect.
        const compiler = createCompiler();

        new webpackPlugin(OPTIONS).apply(compiler);

        await expect(compiler.hooks.shutdown.promise()).resolves.toBeUndefined();

        await new Promise<void>((resolve) => compiler.close(() => resolve()));
    });
});
