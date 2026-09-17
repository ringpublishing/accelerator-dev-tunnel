import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { DataConnectionPool } from '../../src/tunnel/pool.js';
import type { ResolvedConfig } from '../../src/types.js';

interface FakeProxy {
    server: WebSocketServer;
    port: number;
    /** Every connection the pool has opened, in order. */
    connections: WebSocket[];
    /** Frames received from the client, in order. */
    frames: string[];
    /** Upgrade headers of each connection, in order. */
    headers: Record<string, string | string[] | undefined>[];
    /** When set, connections are refused with this close code instead of being parked. */
    rejectWith?: number;
}

async function startProxy(): Promise<FakeProxy> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const proxy: FakeProxy = { server, port: 0, connections: [], frames: [], headers: [] };

    server.on('connection', (ws, request) => {
        proxy.headers.push(request.headers);

        if (proxy.rejectWith) {
            ws.close(proxy.rejectWith, 'missing_headers');

            return;
        }

        proxy.connections.push(ws);
        ws.on('message', (raw) => proxy.frames.push(raw.toString()));
        ws.on('error', () => { /* the pool closes connections abruptly on stop */ });
    });

    await new Promise<void>((resolve) => server.once('listening', resolve));
    proxy.port = (server.address() as AddressInfo).port;

    return proxy;
}

function configFor(port: number): ResolvedConfig {
    return {
        token: 'test-token',
        vhost: 'example.com',
        variant: 'DEV_1',
        port: 3000,
        host: '127.0.0.1',
        idleTimeout: 3600,
        proxy: { host: '127.0.0.1', port },
        noSsl: true,
        ca: undefined,
        insecureTls: false,
        maxReconnectAttempts: 0
    };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error('Condition not met in time');
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe('DataConnectionPool', () => {
    let proxy: FakeProxy;
    let pool: DataConnectionPool;

    beforeEach(async () => {
        proxy = await startProxy();
        pool = new DataConnectionPool(configFor(proxy.port));
    });

    afterEach(async () => {
        pool.stop();
        proxy.server.close();
        await new Promise((resolve) => setTimeout(resolve, 10));
    });

    it('warms exactly one connection at rest', async () => {
        pool.start();
        await waitFor(() => pool.stats().idle === 1);

        // Give any surplus connection a chance to show up before asserting there is none.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(pool.stats().idle).toBe(1);
        expect(proxy.connections).toHaveLength(1);
    });

    it('identifies itself as pooled rather than naming a request', async () => {
        pool.start();
        await waitFor(() => proxy.headers.length === 1);

        const headers = proxy.headers[0] as Record<string, string | undefined>;

        // The upgrade headers are what tell the proxy this connection has no request
        // yet; a request id here would bind it to a request that does not exist.
        expect(headers['x-tunnel-pooled']).toBe('1');
        expect(headers['x-tunnel-request-id']).toBeUndefined();
        expect(headers['x-tunnel-token']).toBe('test-token');
        expect(headers['x-oa-variant']).toBe('example.com::DEV_1');
        expect(headers.host).toBe('example.com');
    });

    it('hands out a warm connection and binds it to the request', async () => {
        pool.start();
        await waitFor(() => pool.stats().idle === 1);

        const ws = pool.acquire('req-1');

        expect(ws).toBeDefined();
        expect(ws?.readyState).toBe(WebSocket.OPEN);
        await waitFor(() => proxy.frames.length === 1);
        expect(JSON.parse(proxy.frames[0] as string)).toEqual({ type: 'bind', requestId: 'req-1' });
        expect(pool.stats().hits).toBe(1);
    });

    it('replaces the connection it handed out', async () => {
        pool.start();
        await waitFor(() => pool.stats().idle === 1);
        pool.acquire('req-1');

        await waitFor(() => pool.stats().idle >= 1);
        expect(proxy.connections.length).toBeGreaterThan(1);
    });

    it('reports a miss and grows when nothing is warm yet', () => {
        const ws = pool.acquire('req-1');

        expect(ws).toBeUndefined();
        expect(pool.stats().misses).toBe(1);
        // A miss is the signal that one warm connection was not enough.
        expect(pool.stats().target).toBe(2);
    });

    it('never grows past the number of connections a browser would open', () => {
        for (let i = 0; i < 20; i++) {
            pool.acquire(`req-${i}`);
        }

        expect(pool.stats().target).toBe(6);
    });

    it('stops pooling once the proxy rejects a parked connection', async () => {
        proxy.rejectWith = 1008;
        pool.start();

        await waitFor(() => !pool.stats().supported);
        expect(pool.stats().idle).toBe(0);

        const before = proxy.connections.length;

        pool.acquire('req-1');
        await new Promise((resolve) => setTimeout(resolve, 50));
        // No further warm-up attempts: requests fall back to opening their own.
        expect(proxy.connections).toHaveLength(before);
    });

    it('closes every warm connection when the tunnel goes away', async () => {
        pool.start();
        await waitFor(() => pool.stats().idle === 1);

        const parked = proxy.connections[0] as WebSocket;
        const closed = new Promise<void>((resolve) => parked.once('close', () => resolve()));

        pool.stop();
        await closed;
        expect(pool.stats().idle).toBe(0);
    });
});
