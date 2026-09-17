import { describe, it, expect } from 'vitest';
import { createTunnel, formatTimestamp, formatRequestLine, parseProxy, resolveConfig as resolveOptions } from '../src/index.js';
import { AuthError, MissingParamError } from '../src/errors.js';
import { TunnelEmitter } from '../src/emitter.js';
import {
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_IDLE_TIMEOUT,
    MAX_IDLE_TIMEOUT,
    RECONNECT_DELAYS,
    type ResolvedConfig
} from '../src/types.js';
import { buildWsConnectionParams } from '../src/tunnel/ws-options.js';

// ── createTunnel validation ──────────────────────────────────────────

describe('createTunnel', () => {
    it('should reject with MissingParamError when token is missing', async () => {
        await expect(
            createTunnel({ token: '', vhost: 'a', variant: 'b', port: 1 })
        ).rejects.toThrow(MissingParamError);
    });

    it('should reject with MissingParamError when vhost is missing', async () => {
        await expect(
            createTunnel({ token: 'x', vhost: '', variant: 'b', port: 1 })
        ).rejects.toThrow(MissingParamError);
    });

    it('should reject with MissingParamError when variant is missing', async () => {
        await expect(
            createTunnel({ token: 'x', vhost: 'a', variant: '', port: 1 })
        ).rejects.toThrow(MissingParamError);
    });

    it('should reject with MissingParamError when neither port nor host is provided', async () => {
        await expect(
            createTunnel({ token: 'x', vhost: 'a', variant: 'b' })
        ).rejects.toThrow(MissingParamError);
    });

    it('should reject with TypeError when port is 0', async () => {
        await expect(
            createTunnel({ token: 'x', vhost: 'a', variant: 'b', port: 0 })
        ).rejects.toThrow(TypeError);
    });

    it('should accept host without port, defaulting the port', () => {
        // Asserted through parseProxy-free validation rather than createTunnel, which
        // would open a real socket and depend on DNS to fail.
        expect(() => resolveOptions({ token: 'x', vhost: 'a', variant: 'b', host: 'localhost' })).not.toThrow();
    });

    it('should reject an idleTimeout above the maximum instead of silently clamping it', () => {
        expect(() => resolveOptions({
            token: 'x', vhost: 'a', variant: 'b', port: 3000, idleTimeout: MAX_IDLE_TIMEOUT + 1
        })).toThrow(TypeError);
    });

    it('should reject a negative idleTimeout instead of silently clamping it', () => {
        expect(() => resolveOptions({
            token: 'x', vhost: 'a', variant: 'b', port: 3000, idleTimeout: -5
        })).toThrow(TypeError);
    });
});

// ── AuthError ────────────────────────────────────────────────────────

describe('AuthError', () => {
    it('should expose reason and formatted message', () => {
        const err = new AuthError('token_expired');
        expect(err.reason).toBe('token_expired');
        expect(err.message).toBe('auth_error: token_expired');
        expect(err.name).toBe('AuthError');
        expect(err).toBeInstanceOf(Error);
    });

    it.each(['token_expired', 'token_invalid', 'token_mismatch'])(
        'should work with reason: %s',
        (reason) => {
            const err = new AuthError(reason);
            expect(err.reason).toBe(reason);
        }
    );
});

// ── MissingParamError ────────────────────────────────────────────────

describe('MissingParamError', () => {
    it('should include the param name in message', () => {
        const err = new MissingParamError('token');
        expect(err.message).toBe('Missing required parameter: token');
        expect(err.name).toBe('MissingParamError');
    });
});

// ── TunnelEmitter ────────────────────────────────────────────────────

describe('TunnelEmitter', () => {
    it('should emit and receive typed events', () => {
        const emitter = new TunnelEmitter();
        const received: string[] = [];

        emitter.on('connect', () => received.push('connect'));
        emitter.on('disconnect', () => received.push('disconnect'));
        emitter.on('reconnect', (attempt) => received.push(`reconnect:${attempt}`));
        emitter.on('request', ({ method, path }) => received.push(`${method} ${path}`));
        emitter.on('error', (err) => received.push(`error:${err.message}`));

        emitter.emit('connect');
        emitter.emit('disconnect', 'stopped');
        emitter.emit('reconnect', 3);
        emitter.emit('request', { method: 'GET', path: '/foo', remoteIp: '1.2.3.4' });
        emitter.emit('error', new Error('boom'));

        expect(received).toEqual([
            'connect',
            'disconnect',
            'reconnect:3',
            'GET /foo',
            'error:boom'
        ]);
    });

    it('should call stop function when stop() is invoked', async () => {
        const emitter = new TunnelEmitter();
        let stopped = false;
        emitter._setStopFn(() => {
            stopped = true;
        });

        await emitter.stop();
        expect(stopped).toBe(true);
    });

    it('should handle stop() gracefully when no stop function is set', async () => {
        const emitter = new TunnelEmitter();
        await expect(emitter.stop()).resolves.toBeUndefined();
    });

    it('should not crash when error is emitted with no user listener', () => {
        const emitter = new TunnelEmitter();
        // ws emits error during initial connection, before caller attaches listeners
        expect(() => emitter.emit('error', new Error('Unexpected server response: 504'))).not.toThrow();
    });

    it('should still deliver errors to user-attached listeners', () => {
        const emitter = new TunnelEmitter();
        const errors: string[] = [];
        emitter.on('error', (err) => errors.push(err.message));
        emitter.emit('error', new Error('one'));
        emitter.emit('error', new Error('two'));
        expect(errors).toEqual(['one', 'two']);
    });
});

// ── Constants ────────────────────────────────────────────────────────

describe('constants', () => {
    it('should have correct default values', () => {
        expect(DEFAULT_HOST).toBe('127.0.0.1');
        expect(DEFAULT_PORT).toBe(80);
        expect(DEFAULT_IDLE_TIMEOUT).toBe(14400);
        expect(MAX_IDLE_TIMEOUT).toBe(86400);
    });

    it('should have correct reconnect delays with 16s cap', () => {
        expect(RECONNECT_DELAYS).toEqual([1000, 2000, 4000, 8000, 16000]);
    });
});

// ── formatTimestamp ──────────────────────────────────────────────────

describe('formatTimestamp', () => {
    it('should format date as YYYY-MM-DD HH:mm:ss in UTC', () => {
        const date = new Date('2026-05-27T17:59:51.578Z');
        expect(formatTimestamp(date)).toBe('2026-05-27 17:59:51');
    });

    it('should use current time when no argument given', () => {
        const result = formatTimestamp();
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });
});

// ── buildWsConnectionParams ──────────────────────────────────────────

describe('buildWsConnectionParams', () => {
    const baseConfig: ResolvedConfig = {
        token: 'jwt',
        vhost: 'example.com',
        variant: 'DEV_1',
        port: 3000,
        host: '127.0.0.1',
        idleTimeout: 14400,
        proxy: undefined,
        noSsl: false,
        ca: undefined,
        insecureTls: false,
        maxReconnectAttempts: 0
    };

    it('should build wss:// URL to vhost when no proxy and ssl', () => {
        const { url, options } = buildWsConnectionParams(baseConfig, '/__acc/dev-tunnel/register');
        expect(url).toBe('wss://example.com/__acc/dev-tunnel/register');
        expect(options.headers).not.toHaveProperty('Host');
        expect(options.servername).toBeUndefined();
    });

    it('should build ws:// URL to vhost when noSsl and no proxy', () => {
        const config = { ...baseConfig, noSsl: true };
        const { url, options } = buildWsConnectionParams(config, '/__acc/dev-tunnel/register');
        expect(url).toBe('ws://example.com/__acc/dev-tunnel/register');
        expect(options.headers).not.toHaveProperty('Host');
        expect(options.servername).toBeUndefined();
    });

    it('should build wss:// URL to proxy with Host header and SNI when proxy + ssl', () => {
        const config = { ...baseConfig, proxy: { host: 'localhost', port: 8080 } };
        const { url, options } = buildWsConnectionParams(config, '/__acc/dev-tunnel/data');
        expect(url).toBe('wss://localhost:8080/__acc/dev-tunnel/data');
        expect((options.headers as Record<string, string>).Host).toBe('example.com');
        expect(options.servername).toBe('example.com');
    });

    it('should build ws:// URL to proxy with Host header but no SNI when proxy + noSsl', () => {
        const config = { ...baseConfig, noSsl: true, proxy: { host: 'myproxy', port: 80 } };
        const { url, options } = buildWsConnectionParams(config, '/__acc/dev-tunnel/data');
        expect(url).toBe('ws://myproxy:80/__acc/dev-tunnel/data');
        expect((options.headers as Record<string, string>).Host).toBe('example.com');
        expect(options.servername).toBeUndefined();
    });

    it('should merge extra headers', () => {
        const { options } = buildWsConnectionParams(baseConfig, '/path', { 'x-custom': 'val' });
        expect((options.headers as Record<string, string>)['x-custom']).toBe('val');
    });
});

// ── parseProxy ───────────────────────────────────────────────────────

describe('parseProxy', () => {
    it('should return undefined when no proxy is configured', () => {
        expect(parseProxy(undefined, false)).toBeUndefined();
    });

    it('should default the port to 443, or 80 without TLS', () => {
        expect(parseProxy('example.com', false)).toEqual({ host: 'example.com', port: 443 });
        expect(parseProxy('example.com', true)).toEqual({ host: 'example.com', port: 80 });
    });

    it('should split host and port', () => {
        expect(parseProxy('example.com:8080', false)).toEqual({ host: 'example.com', port: 8080 });
    });

    it('should reject an out-of-range port rather than folding it into the host', () => {
        // Previously produced wss://example.com:99999:443/... and an opaque ERR_INVALID_URL.
        expect(() => parseProxy('example.com:99999', false)).toThrow(/not a port between 1 and 65535/);
    });

    it.each(['example.com:0', 'example.com:abc', 'example.com:-1', 'example.com:80.5'])(
        'should reject %p',
        (proxy) => {
            expect(() => parseProxy(proxy, false)).toThrow(TypeError);
        }
    );

    it('should reject a port with no host', () => {
        expect(() => parseProxy(':443', false)).toThrow(/missing host/);
    });

    it('should treat a bare IPv6 address as a host, not a host:port', () => {
        expect(parseProxy('::1', false)).toEqual({ host: '::1', port: 443 });
        expect(parseProxy('2001:db8::1', true)).toEqual({ host: '2001:db8::1', port: 80 });
    });

    it('should support bracketed IPv6 with and without a port', () => {
        expect(parseProxy('[::1]', false)).toEqual({ host: '::1', port: 443 });
        expect(parseProxy('[::1]:8080', false)).toEqual({ host: '::1', port: 8080 });
    });
});

// ── formatTimestamp ──────────────────────────────────────────────────

describe('formatTimestamp without a date library', () => {
    it('should format a UTC timestamp as YYYY-MM-DD HH:mm:ss', () => {
        expect(formatTimestamp(new Date('2026-03-04T05:06:07.890Z'))).toBe('2026-03-04 05:06:07');
    });
});

// ── TLS trust options ────────────────────────────────────────────────

describe('TLS trust options', () => {
    const base = { token: 'x', vhost: 'example.com', variant: 'DEV_1', port: 3000 };

    it('should reject combining insecureTls with ca', () => {
        // Trusting a specific certificate while verifying nothing is incoherent, and
        // silently letting one win would hide which of the two took effect.
        expect(() => resolveOptions({ ...base, ca: 'PEM', insecureTls: true })).toThrow(TypeError);
    });

    it('should default to full verification', () => {
        const config = resolveOptions(base);

        expect(config.ca).toBeUndefined();
        expect(config.insecureTls).toBe(false);
    });

    it('should pass an extra certificate through to the socket options', () => {
        const config = resolveOptions({ ...base, ca: 'PEM DATA' });
        const { options } = buildWsConnectionParams(config, '/__acc/dev-tunnel/register');

        expect(options.ca).toBe('PEM DATA');
        expect(options.rejectUnauthorized).toBeUndefined();
    });

    it('should turn verification off only when asked', () => {
        const config = resolveOptions({ ...base, insecureTls: true });
        const { options } = buildWsConnectionParams(config, '/__acc/dev-tunnel/register');

        expect(options.rejectUnauthorized).toBe(false);
    });

    it('should not set TLS options at all without TLS', () => {
        const config = resolveOptions({ ...base, noSsl: true, insecureTls: true });
        const { options } = buildWsConnectionParams(config, '/__acc/dev-tunnel/register');

        expect(options.rejectUnauthorized).toBeUndefined();
        expect(options.ca).toBeUndefined();
    });
});

// ── formatRequestLine ────────────────────────────────────────────────

describe('formatRequestLine', () => {
    const base = { method: 'GET', path: '/api/articles', remoteIp: '203.0.113.10' };

    it('says what the application answered and how long it took', () => {
        const line = formatRequestLine({ ...base, statusCode: 200, durationMs: 14 });

        expect(line).toContain('GET /api/articles → 200 14ms 203.0.113.10');
    });

    it('says so when nothing answered at all', () => {
        // A request that produces no line is the case someone watching needs to see.
        const line = formatRequestLine({ ...base, statusCode: 0, durationMs: 15_000 });

        expect(line).toContain('→ no response');
        // No duration either: fifteen seconds of waiting is not a response time.
        expect(line).not.toContain('ms');
    });
});
