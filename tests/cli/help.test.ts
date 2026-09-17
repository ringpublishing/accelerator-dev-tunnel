import { describe, it, expect, afterEach, vi } from 'vitest';
import { printCommandHelp } from '../../src/cli/help.js';

/** Captures what the CLI would print, without letting it reach the terminal. */
function capture(run: () => void): string {
    let output = '';

    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        output += String(chunk);

        return true;
    });

    try {
        run();
    } finally {
        write.mockRestore();
    }

    return output;
}

describe('printCommandHelp', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([
        ['start', undefined, 'acc-dev-tunnel start'],
        ['check', undefined, 'acc-dev-tunnel check'],
        ['setup', undefined, 'acc-dev-tunnel setup'],
        ['config', undefined, 'acc-dev-tunnel config —'],
        ['config', 'set', 'acc-dev-tunnel config set'],
        ['config', 'get', 'acc-dev-tunnel config get'],
        ['config', 'list', 'acc-dev-tunnel config list'],
        ['config', 'remove', 'acc-dev-tunnel config remove']
    ])('answers --help for %s %s', (command, subcommand, expected) => {
        // The top-level help promises per-command help for everything. It used to exist
        // for two commands, and the rest silently printed the general text instead.
        const output = capture(() => printCommandHelp(command, subcommand));

        expect(output).toContain(expected);
        expect(output).toContain('Usage:');
    });

    it('falls back to the general help for an unknown command', () => {
        const output = capture(() => printCommandHelp('frobnicate', undefined));

        expect(output).toContain('Ring Accelerator dev-tunnel client');
        expect(output).toContain('Commands:');
    });

    it('lists every command it can then explain', () => {
        // A command missing from this list is a command nobody discovers.
        const output = capture(() => printCommandHelp(undefined, undefined));

        for (const command of ['start', 'check', 'setup', 'config list', 'config get', 'config set', 'config remove']) {
            expect(output).toContain(command);
        }
    });
});
