const LOG_PREFIX = '[acc-dev-tunnel]';

/** Everything the CLI says, said the same way. */
export function log(msg: string): void {
    process.stdout.write(`${LOG_PREFIX} ${msg}\n`);
}

export function logError(msg: string): void {
    process.stderr.write(`${LOG_PREFIX} ${msg}\n`);
}
