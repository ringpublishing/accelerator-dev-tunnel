/**
 * Turn the errors people actually hit on a first run into something actionable.
 *
 * A mistyped vhost is the most likely way a first run fails, and reporting it as an
 * unexpected `getaddrinfo ENOTFOUND` tells the one person who cannot act on it.
 */
export function describeStartupError(err: unknown, vhost: string, proxy: string | undefined): string {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const target = proxy ?? vhost;

    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return `Cannot resolve ${target}. Check the name for typos, and that it is an Accelerator vhost. `
            + 'If it does not resolve from this network, pass --proxy <host> to connect through a known entry point.';
    }

    if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
        return `Cannot reach ${target}: ${message}. Check your network access to Accelerator.`;
    }

    // The host answered, but not the way a dev-tunnel vhost does. Reached by pointing
    // at an ordinary web server — the first thing anyone tries — and the raw message
    // ("Unexpected server response: 404") says nothing about what is wrong.
    const status = /Unexpected server response: (\d{3})/.exec(message)?.[1];

    if (status) {
        return `${target} answered ${status} to the tunnel handshake, so it is not serving a dev-tunnel variant. `
            + 'Check that the vhost is on Accelerator and that its variant is configured as `dev-tunnel`, '
            + 'and that the variant name matches the one in your token.';
    }

    if (message.includes('Invalid URL') || code === 'ERR_INVALID_URL') {
        return `Cannot build a connection to ${target}: ${message}. `
            + 'Check the vhost, and the --proxy value if you passed one.';
    }

    return `Unexpected error: ${message}`;
}
