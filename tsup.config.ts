import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

/**
 * The package version lives in the CHANGELOG, not in package.json — the shared CDP
 * release workflow derives it from the top heading. `--version` has to report the same
 * number, so read it from the same place at build time.
 */
function readVersion(): string {
    const changelog = readFileSync(new URL('./CHANGELOG.md', import.meta.url), 'utf-8');
    const match = /^##\s+\[?(\d+\.\d+\.\d+)\]?/m.exec(changelog);

    return match ? match[1] : '0.0.0-dev';
}

const define = { __VERSION__: JSON.stringify(readVersion()) };

export default defineConfig([
    {
        entry: {
            'index': 'src/index.ts',
            'plugins/vite': 'src/plugins/vite.ts',
            'plugins/webpack': 'src/plugins/webpack.ts'
        },
        format: ['esm', 'cjs'],
        dts: true,
        sourcemap: true,
        clean: true,
        target: 'node20',
        define,
        // Shared chunks, so `err instanceof AuthError` holds across entry points and
        // the library is not inlined three times into the tarball.
        splitting: true
    },
    {
        entry: {
            'cli/index': 'src/cli/index.ts'
        },
        format: ['esm'],
        banner: { js: '#!/usr/bin/env node' },
        dts: false,
        sourcemap: true,
        target: 'node20',
        define,
        splitting: false
    }
]);
