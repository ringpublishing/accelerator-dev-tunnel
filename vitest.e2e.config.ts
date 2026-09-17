import { defineConfig } from 'vitest/config';

/**
 * End-to-end suite, run by hand against a deployed environment.
 *
 * Separate from the unit config because it needs Accelerator on the other end, and
 * because a variant accepts exactly one control connection, so these run serially and
 * never as part of CI.
 */
export default defineConfig({
    test: {
        include: ['tests/e2e/**/*.e2e.test.ts'],
        fileParallelism: false,
        // Every case sets its own timeout; this is a backstop for setup.
        testTimeout: 120_000,
        hookTimeout: 180_000
    }
});
