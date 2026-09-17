import { parseArgs } from 'node:util';
import { logError } from './output.js';
import { printHelp, printCommandHelp } from './help.js';
import { commandStart } from './commands/start.js';
import { commandCheck } from './commands/check.js';
import {
    commandSetup,
    commandConfigList,
    commandConfigGet,
    commandConfigSet,
    commandConfigRemove
} from './commands/config.js';

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const { values, positionals } = parseArgs({
        args: process.argv.slice(2),
        options: {
            'token': { type: 'string' },
            'port': { type: 'string' },
            'host': { type: 'string' },
            'idle-timeout': { type: 'string' },
            'proxy': { type: 'string' },
            'no-ssl': { type: 'boolean' },
            'ca': { type: 'string' },
            'insecure-tls': { type: 'boolean' },
            'help': { type: 'boolean', short: 'h' },
            'version': { type: 'boolean', short: 'v' }
        },
        allowPositionals: true,
        strict: true
    });

    const command = positionals[0];

    if (values.version) {
        process.stdout.write(`${__VERSION__}\n`);

        return;
    }

    if (values.help) {
        printCommandHelp(command, positionals[1]);

        return;
    }

    if (!command) {
        printHelp();

        return;
    }

    switch (command) {
        case 'start':
            await commandStart(positionals[1], positionals[2], values);
            break;
        case 'check':
            await commandCheck(positionals[1], positionals[2], values);
            break;
        case 'setup':
            await commandSetup();
            break;
        case 'config':
            switch (positionals[1]) {
                case 'list':
                    await commandConfigList();
                    break;
                case 'get':
                    await commandConfigGet(positionals[2], positionals[3]);
                    break;
                case 'set':
                    await commandConfigSet(positionals[2], positionals[3], values);
                    break;
                case 'remove':
                    await commandConfigRemove(positionals[2], positionals[3]);
                    break;
                default:
                    logError('Usage: acc-dev-tunnel config <list|get|set|remove>');
                    process.exit(2);
            }

            break;
        default:
            logError(`Unknown command: ${command}`);
            printHelp();
            process.exitCode = 2;
    }
}

main().catch((err: unknown) => {
    // Without this, anything that rejects here — an unwritable config directory, a
    // parseArgs failure — surfaces as a bare Node stack trace with no context.
    logError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
