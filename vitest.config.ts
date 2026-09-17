import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // The end-to-end suite needs a deployed environment; it has its own config.
        exclude: [
            'node_modules/**',
            'tests/e2e/**'
        ]
    }
});
