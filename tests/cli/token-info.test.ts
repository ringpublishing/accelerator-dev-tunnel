import { describe, it, expect } from 'vitest';
import { inspectToken, MalformedTokenError } from '../../src/cli/token-info.js';

/** Builds a token the way a JWT is shaped, without signing anything. */
function tokenWith(claims: Record<string, unknown>): string {
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

    return `${encode({ alg: 'HS256' })}.${encode(claims)}.signature`;
}

describe('inspectToken', () => {
    it('reads the variant a token was issued for', () => {
        const info = inspectToken(tokenWith({ vhost: 'example.com', variant: 'DEV_1' }));

        expect(info).toMatchObject({ vhost: 'example.com', variant: 'DEV_1' });
    });

    it('converts the expiry from seconds to milliseconds', () => {
        // `exp` is seconds by the JWT spec, and milliseconds everywhere else here —
        // reading it raw would put every expiry some 50,000 years out.
        const info = inspectToken(tokenWith({ exp: 1_700_000_000 }));

        expect(info.expiresAt).toBe(1_700_000_000_000);
    });

    it('reports no expiry when the token carries none', () => {
        expect(inspectToken(tokenWith({ vhost: 'example.com' })).expiresAt).toBeUndefined();
    });

    it('ignores claims of the wrong type rather than trusting them', () => {
        const info = inspectToken(tokenWith({ vhost: 42, variant: null, exp: 'soon' }));

        expect(info).toEqual({ vhost: undefined, variant: undefined, expiresAt: undefined });
    });

    it('rejects something that is not a JWT at all', () => {
        expect(() => inspectToken('just-a-string')).toThrow(MalformedTokenError);
    });

    it('rejects a payload that is not JSON', () => {
        const notJson = Buffer.from('not json').toString('base64url');

        expect(() => inspectToken(`header.${notJson}.signature`)).toThrow(/not valid JSON/);
    });

    it('rejects a payload that is JSON but not an object', () => {
        const array = Buffer.from('[1,2,3]').toString('base64url');

        expect(() => inspectToken(`header.${array}.signature`)).toThrow(/not an object/);
    });
});
