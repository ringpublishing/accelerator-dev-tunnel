import { describe, it, expect } from 'vitest';
import { checkToken, humanizeDuration } from '../../src/cli/diagnostics.js';

function tokenWith(claims: Record<string, unknown>): string {
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

    return `${encode({ alg: 'HS256' })}.${encode(claims)}.signature`;
}

const HOUR_MS = 3_600_000;

describe('humanizeDuration', () => {
    it.each([
        [5_000, '5s'],
        [90_000, '1m'],
        [HOUR_MS + 600_000, '1h10m'],
        [50 * HOUR_MS, '2d2h']
    ])('renders %ims as %s', (ms, expected) => {
        expect(humanizeDuration(ms)).toBe(expected);
    });

    it('does not render a long validity in hours', () => {
        // 707h is technically correct and useless; nobody reads it as a month.
        expect(humanizeDuration(707 * HOUR_MS)).toBe('29d11h');
    });
});

describe('checkToken', () => {
    it('accepts a token issued for the variant being checked', () => {
        const token = tokenWith({
            vhost: 'example.com',
            variant: 'DEV_1',
            exp: Math.floor(Date.now() / 1000) + 3600
        });

        expect(checkToken(token, 'example.com', 'DEV_1')).toMatchObject({ ok: true, label: 'token' });
    });

    it('rejects a token that has expired', () => {
        const token = tokenWith({ exp: Math.floor(Date.now() / 1000) - 3600 });
        const result = checkToken(token, 'example.com', 'DEV_1');

        expect(result.ok).toBe(false);
        expect(result.detail).toContain('expired');
    });

    it('rejects a token issued for another variant', () => {
        // It authenticates and then serves nothing, which is a long way to walk before
        // finding out the token came from the wrong place.
        const token = tokenWith({ vhost: 'other.com', variant: 'DEV_9' });
        const result = checkToken(token, 'example.com', 'DEV_1');

        expect(result.ok).toBe(false);
        expect(result.detail).toContain('other.com::DEV_9');
    });

    it('accepts a token that says nothing about its variant', () => {
        // Nothing to contradict, so nothing to report — the proxy is the authority.
        expect(checkToken(tokenWith({}), 'example.com', 'DEV_1').ok).toBe(true);
    });

    it('reports an unreadable token rather than throwing', () => {
        const result = checkToken('not-a-jwt', 'example.com', 'DEV_1');

        expect(result.ok).toBe(false);
        expect(result.detail).toContain('not a readable JWT');
    });
});
