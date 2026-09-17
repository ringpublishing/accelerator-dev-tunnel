import { getConfigPath } from '../config/index.js';
import { DEFAULT_IDLE_TIMEOUT, MAX_IDLE_TIMEOUT, DEFAULT_PORT, DEFAULT_HOST } from '../types.js';

export function printHelp(): void {
    const help = `
acc-dev-tunnel — Ring Accelerator dev-tunnel client

Usage:
  acc-dev-tunnel <command> [options]

Commands:
  start [<vhost> <variant>]        Start a dev-tunnel connection
  check [<vhost> <variant>]        Diagnose a tunnel without starting one
  setup                            Interactive configuration wizard
  config list                      List saved tunnel configurations
  config get <vhost> <variant>     Show a tunnel configuration
  config set <vhost> <variant>     Save a tunnel configuration
  config remove <vhost> <variant>  Remove a saved tunnel configuration

Options:
  --help, -h        Show this help message
  --version, -v     Print the version

Run 'acc-dev-tunnel <command> --help' for command-specific options.
Configuration is stored in ${getConfigPath()}.
`.trimStart();

    process.stdout.write(help);
}

export function printCheckHelp(): void {
    const help = `
acc-dev-tunnel check — Diagnose a tunnel without starting one

Usage:
  acc-dev-tunnel check [<vhost> <variant>] [options]

Reports on each part separately, so a tunnel that does not work says which part is
at fault: the saved configuration, what the token claims and when it expires,
whether your local application answers, and whether a tunnel actually comes up.

With one saved configuration the arguments can be left out.

Options:
  --token <jwt>           Check this token instead of the saved one
  --host <host>           Local host to probe
  --port <port>           Local port to probe
  --proxy <host[:port]>   Connect via proxy (env: ACC_DEV_TUNNEL_PROXY)
  --no-ssl                Use ws:// instead of wss://
  --ca <file>             Trust an extra certificate (PEM)
  --insecure-tls          Disable certificate verification entirely

Exits 1 if anything failed.
`.trimStart();

    process.stdout.write(help);
}

export function printSetupHelp(): void {
    const help = `
acc-dev-tunnel setup — Interactive configuration wizard

Usage:
  acc-dev-tunnel setup

Asks for the token, vhost, variant and local address, then saves them to
${getConfigPath()} so 'start <vhost> <variant>' needs no options.

Takes no options. For scripted configuration use 'acc-dev-tunnel config set'.
`.trimStart();

    process.stdout.write(help);
}

export function printConfigHelp(): void {
    const help = `
acc-dev-tunnel config — Manage saved tunnel configurations

Usage:
  acc-dev-tunnel config list
  acc-dev-tunnel config get <vhost> <variant>
  acc-dev-tunnel config set <vhost> <variant> [options]
  acc-dev-tunnel config remove <vhost> <variant>

Commands:
  list                             List saved tunnel configurations
  get <vhost> <variant>            Show one, with the token masked
  set <vhost> <variant>            Save or update one
  remove <vhost> <variant>         Delete one

Configuration is stored in ${getConfigPath()}, readable only by you.
Run 'acc-dev-tunnel config set --help' for the options it takes.
`.trimStart();

    process.stdout.write(help);
}

export function printConfigGetHelp(): void {
    const help = `
acc-dev-tunnel config get — Show a tunnel configuration

Usage:
  acc-dev-tunnel config get <vhost> <variant>

Prints the saved entry as JSON. The token is masked; the config file itself
(${getConfigPath()}) holds the full value.
`.trimStart();

    process.stdout.write(help);
}

export function printConfigListHelp(): void {
    const help = `
acc-dev-tunnel config list — List saved tunnel configurations

Usage:
  acc-dev-tunnel config list

Prints one '<vhost> <variant>' pair per line, for use with 'start'.
`.trimStart();

    process.stdout.write(help);
}

export function printConfigRemoveHelp(): void {
    const help = `
acc-dev-tunnel config remove — Remove a tunnel configuration

Usage:
  acc-dev-tunnel config remove <vhost> <variant>

Exits 1 if there was no such entry.
`.trimStart();

    process.stdout.write(help);
}

export function printStartHelp(): void {
    const help = `
acc-dev-tunnel start — Start a dev-tunnel connection

Usage:
  acc-dev-tunnel start [<vhost> <variant>] [options]

Connection parameters (token, host, port, noSsl) are loaded from the config file.
Use 'acc-dev-tunnel setup' or 'acc-dev-tunnel config set' to configure them.
With exactly one saved configuration the arguments can be left out.

Options:
  --idle-timeout <sec>    Exit after N seconds of inactivity (default: ${DEFAULT_IDLE_TIMEOUT}, max: ${MAX_IDLE_TIMEOUT})
  --proxy <host[:port]>   Connect via proxy (env: ACC_DEV_TUNNEL_PROXY)
  --token <jwt>           Override the token from the config file
  --host <host>           Override the local host to forward to
  --port <port>           Override the local port to forward to
  --no-ssl                Use ws:// instead of wss://
  --ca <file>             Trust an extra certificate (PEM), for a vhost using a
                          self-signed one. Verification stays on.
  --insecure-tls          Disable certificate verification entirely. Prefer --ca.

Token can also be provided via ACC_DEV_TUNNEL_TOKEN environment variable.
`.trimStart();

    process.stdout.write(help);
}

export function printConfigSetHelp(): void {
    const help = `
acc-dev-tunnel config set — Save a tunnel configuration

Usage:
  acc-dev-tunnel config set <vhost> <variant> [options]

Options:
  --token <token>     JWT token
  --port <port>       Local port (default: ${DEFAULT_PORT})
  --host <host>       Local host (default: ${DEFAULT_HOST})
  --no-ssl            Disable TLS, use ws:// instead of wss://
  --ca <file>         Trust an extra certificate (PEM), e.g. a self-signed one
  --insecure-tls      Disable certificate verification entirely (prefer --ca)

Saves the configuration to ${getConfigPath()} for use with 'start'.
`.trimStart();

    process.stdout.write(help);
}

/** Every command answers --help; the top-level text promises as much. */
export function printCommandHelp(command: string | undefined, subcommand: string | undefined): void {
    if (command === 'start') {
        printStartHelp();

        return;
    }

    if (command === 'check') {
        printCheckHelp();

        return;
    }

    if (command === 'setup') {
        printSetupHelp();

        return;
    }

    if (command === 'config') {
        switch (subcommand) {
            case 'set':
                printConfigSetHelp();

                return;
            case 'get':
                printConfigGetHelp();

                return;
            case 'list':
                printConfigListHelp();

                return;
            case 'remove':
                printConfigRemoveHelp();

                return;
            default:
                printConfigHelp();

                return;
        }
    }

    printHelp();
}
