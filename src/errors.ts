/* eslint-disable max-classes-per-file */

/**
 * Errors the tunnel reports to its caller.
 *
 * Exported from the package root so `instanceof` works, which is how a caller tells a
 * bad token apart from someone else claiming the variant.
 */

export class AuthError extends Error {
    public readonly reason: string;

    constructor(reason: string) {
        super(`auth_error: ${reason}`);
        this.name = 'AuthError';
        this.reason = reason;
    }
}

// ── Missing param error ──────────────────────────────────────────────

/**
 * Another client registered the same vhost/variant and now holds the tunnel.
 *
 * The proxy signals this by reusing the auth_error frame, but nothing was wrong with
 * this client's token — reporting it as an authentication failure sends developers
 * looking in entirely the wrong place.
 */
export class TakeoverError extends Error {
    constructor() {
        super('Another client connected to this vhost and variant and took over the tunnel');
        this.name = 'TakeoverError';
    }
}

export class MissingParamError extends Error {
    constructor(param: string) {
        super(`Missing required parameter: ${param}`);
        this.name = 'MissingParamError';
    }
}

// ── Tunnel class (typed EventEmitter) ────────────────────────────────
