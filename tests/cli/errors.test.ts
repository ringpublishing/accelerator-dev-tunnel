import { describe, it, expect } from 'vitest';
import { describeStartupError } from '../../src/cli/errors.js';

function withCode(code: string, message = 'boom'): NodeJS.ErrnoException {
    return Object.assign(new Error(message), { code });
}

describe('describeStartupError', () => {
    it('explains a vhost that does not resolve', () => {
        // The most likely way a first run fails, and the one people cannot act on when
        // it arrives as a bare errno.
        const message = describeStartupError(withCode('ENOTFOUND'), 'typo.example.com', undefined);

        expect(message).toContain('typo.example.com');
        expect(message).toContain('--proxy');
        expect(message).not.toContain('Unexpected');
    });

    it('treats a temporary resolver failure the same way', () => {
        expect(describeStartupError(withCode('EAI_AGAIN'), 'example.com', undefined)).toContain('Cannot resolve');
    });

    it('names the proxy rather than the vhost when connecting through one', () => {
        // With --proxy the vhost is never resolved, so naming it would send the reader
        // to check the wrong thing.
        const message = describeStartupError(withCode('ENOTFOUND'), 'example.com', 'entry.internal');

        expect(message).toContain('entry.internal');
        expect(message).not.toContain('example.com');
    });

    it.each(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'])(
        'reports %s as a reachability problem',
        (code) => {
            const message = describeStartupError(withCode(code, 'connect failed'), 'example.com', undefined);

            expect(message).toContain('Cannot reach example.com');
            expect(message).toContain('connect failed');
        }
    );

    it('passes anything else through rather than guessing', () => {
        expect(describeStartupError(new Error('something else'), 'example.com', undefined))
            .toBe('Unexpected error: something else');
    });

    it('copes with a thrown value that is not an Error', () => {
        expect(describeStartupError('just a string', 'example.com', undefined))
            .toBe('Unexpected error: just a string');
    });
});

describe('describeStartupError, on a host that is not a dev-tunnel vhost', () => {
    it('explains a handshake answered with an HTTP status', () => {
        // What pointing at an ordinary web server looks like, and the first mistake
        // anyone makes. "Unexpected server response: 404" tells them nothing.
        const message = describeStartupError(
            new Error('Unexpected server response: 404'),
            'example.com',
            undefined
        );

        expect(message).toContain('answered 404');
        expect(message).toContain('dev-tunnel');
        expect(message).not.toContain('Unexpected error');
    });

    it('explains a URL it could not build', () => {
        const message = describeStartupError(withCode('ERR_INVALID_URL', 'Invalid URL'), 'example.com', 'host:99999');

        expect(message).toContain('--proxy');
    });
});
