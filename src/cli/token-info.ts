/**
 * What a dev-tunnel token says about itself.
 *
 * Read, not verified — only the proxy holds the signing secret. That is enough to catch
 * the mistakes people actually make: an expired token, or one pasted from a different
 * variant than the one being started.
 */
export interface TokenInfo {
    vhost?: string;
    variant?: string;
    /** Expiry as epoch milliseconds, when the token carries one. */
    expiresAt?: number;
}

export class MalformedTokenError extends Error {
    constructor(reason: string) {
        super(`Token is not a readable JWT: ${reason}`);
        this.name = 'MalformedTokenError';
    }
}

export function inspectToken(token: string): TokenInfo {
    const parts = token.split('.');

    if (parts.length !== 3) {
        throw new MalformedTokenError(`expected three dot-separated parts, found ${parts.length}`);
    }

    let payload: unknown;

    try {
        payload = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf-8'));
    } catch {
        throw new MalformedTokenError('the payload is not valid JSON');
    }

    // Arrays are objects too, so a bare typeof check would let `[1,2,3]` through and
    // read every claim as undefined — the same trap the config loader guards against.
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new MalformedTokenError('the payload is not an object');
    }

    const claims = payload as Record<string, unknown>;

    return {
        vhost: typeof claims.vhost === 'string' ? claims.vhost : undefined,
        variant: typeof claims.variant === 'string' ? claims.variant : undefined,
        // `exp` is in seconds; everything else in this codebase counts milliseconds.
        expiresAt: typeof claims.exp === 'number' ? claims.exp * 1000 : undefined
    };
}
