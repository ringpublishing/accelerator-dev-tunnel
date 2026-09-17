/**
 * Configuration for the end-to-end suite.
 *
 * Nothing here is committed: the vhost, the endpoints and the credentials all come
 * from the environment.
 */
export interface E2eConfig {
    /** Accelerator vhost carrying the dev-tunnel variant, e.g. `dev-tunnel-e2e.example.com`. */
    vhost: string;
    /** Variant name, e.g. `DEV_1`. */
    variant: string;
    /** JWT for that variant. */
    token: string;
    /**
     * Accelerator entry point to drive.
     *
     * The suite connects to this address directly and sets `Host` and the TLS SNI to
     * the vhost, so the target is chosen per connection instead of by DNS. That is what
     * makes it possible to register a tunnel through one entry point and assert against
     * another.
     */
    primaryEndpoint: string;
    /** A second entry point, enabling the routing cases. */
    secondaryEndpoint?: string;
    /**
     * Whether to speak TLS to the entry point.
     *
     * Some environments have no certificate for the vhost, and there the suite has to
     * use plain HTTP. It changes nothing about what is being tested.
     */
    tls: boolean;
    /**
     * PEM file to trust, for a vhost carrying a self-signed certificate.
     *
     * Passed to the client's own `ca` option rather than to Node's trust store, so the
     * suite exercises the thing a developer would actually reach for.
     */
    caFile?: string;
}

export function readE2eConfig(): E2eConfig | null {
    const vhost = process.env.E2E_VHOST;
    const variant = process.env.E2E_VARIANT;
    const token = process.env.E2E_TOKEN;
    const primaryEndpoint = process.env.E2E_ENDPOINT_PRIMARY;

    if (!vhost || !variant || !token || !primaryEndpoint) {
        return null;
    }

    return {
        vhost,
        variant,
        token,
        primaryEndpoint,
        secondaryEndpoint: process.env.E2E_ENDPOINT_SECONDARY,
        tls: process.env.E2E_TLS !== 'false',
        caFile: process.env.E2E_CA_FILE
    };
}

export const MISSING_CONFIG_MESSAGE
    = 'E2E configuration missing. Set E2E_VHOST, E2E_VARIANT, E2E_TOKEN and E2E_ENDPOINT_PRIMARY '
    + '(optionally E2E_ENDPOINT_SECONDARY to enable the routing cases).';
