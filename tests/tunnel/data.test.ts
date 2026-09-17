import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { handleDataConnection } from '../../src/tunnel/data.js';
import { TunnelEmitter } from '../../src/emitter.js';
import type { OpenDataMessage } from '../../src/protocol.js';
import type { ResponseInfo, ResolvedConfig } from '../../src/types.js';

interface FakeProxy {
    server: WebSocketServer;
    port: number;
    /** Raw bytes the client relayed back from the local application. */
    received: Buffer[];
    /** Resolves once the client closed the data connection. */
    finished: Promise<void>;
}

/** Stands in for the proxy: sends a request head, collects the response. */
async function startProxy(requestHead: string): Promise<FakeProxy> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const received: Buffer[] = [];
    let markFinished = (): void => undefined;
    const finished = new Promise<void>((resolve) => {
        markFinished = resolve;
    });

    server.on('connection', (ws) => {
        ws.on('message', (data) => received.push(Buffer.from(data as Buffer)));
        ws.on('close', () => markFinished());
        ws.on('error', () => markFinished());
        ws.send(Buffer.from(requestHead));
    });

    await new Promise<void>((resolve) => server.once('listening', resolve));

    return { server, port: (server.address() as AddressInfo).port, received, finished };
}

function configFor(proxyPort: number, localPort: number): ResolvedConfig {
    return {
        token: 'test-token',
        vhost: 'example.com',
        variant: 'DEV_1',
        port: localPort,
        host: '127.0.0.1',
        idleTimeout: 3600,
        proxy: { host: '127.0.0.1', port: proxyPort },
        noSsl: true,
        ca: undefined,
        insecureTls: false,
        maxReconnectAttempts: 0
    };
}

function openData(path: string, method = 'GET'): OpenDataMessage {
    return { type: 'open_data', requestId: 'req-1', method, path, remoteIp: '10.0.0.1' };
}

describe('handleDataConnection', () => {
    let localApp: http.Server;
    let localPort = 0;

    beforeEach(async () => {
        localApp = http.createServer((req, res) => {
            if (req.url === '/missing') {
                res.writeHead(404).end('nope');

                return;
            }

            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('hello');
        });

        await new Promise<void>((resolve) => localApp.listen(0, '127.0.0.1', resolve));
        localPort = (localApp.address() as AddressInfo).port;
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => localApp.close(() => resolve()));
    });

    it('reports the status the local application returned', async () => {
        // Without this the terminal cannot tell a working tunnel from a broken
        // application: both produce a line, and only one of them is fine.
        const proxy = await startProxy('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
        const tunnel = new TunnelEmitter();
        const reported: ResponseInfo[] = [];

        tunnel.on('response', (info) => reported.push(info));
        handleDataConnection(openData('/'), configFor(proxy.port, localPort), tunnel);

        await proxy.finished;

        expect(Buffer.concat(proxy.received).toString()).toContain('hello');
        expect(reported).toHaveLength(1);
        expect(reported[0]?.statusCode).toBe(200);
        expect(reported[0]?.path).toBe('/');
        expect(reported[0]?.durationMs).toBeGreaterThanOrEqual(0);

        proxy.server.close();
    });

    it('reports a failing status rather than only a successful one', async () => {
        const proxy = await startProxy('GET /missing HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
        const tunnel = new TunnelEmitter();
        const reported: ResponseInfo[] = [];

        tunnel.on('response', (info) => reported.push(info));
        handleDataConnection(openData('/missing'), configFor(proxy.port, localPort), tunnel);

        await proxy.finished;

        expect(reported[0]?.statusCode).toBe(404);

        proxy.server.close();
    });

    it('answers 502 when the local application is not running', async () => {
        const proxy = await startProxy('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n');
        const tunnel = new TunnelEmitter();
        const reported: ResponseInfo[] = [];

        tunnel.on('response', (info) => reported.push(info));
        // Port 1 is reserved and never listening, so this is a refused connection.
        handleDataConnection(openData('/'), configFor(proxy.port, 1), tunnel);

        await proxy.finished;

        // A synthetic 502 down the tunnel, because closing silently makes the proxy end
        // an unwritten response — which Node completes as an empty, cacheable 200.
        expect(Buffer.concat(proxy.received).toString()).toContain('502 Bad Gateway');
        expect(reported).toHaveLength(1);
        expect(reported[0]?.statusCode).toBe(502);

        proxy.server.close();
    });

    it('reports exactly once even though several paths could', async () => {
        const proxy = await startProxy('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
        const tunnel = new TunnelEmitter();
        const reported: ResponseInfo[] = [];

        tunnel.on('response', (info) => reported.push(info));
        handleDataConnection(openData('/'), configFor(proxy.port, localPort), tunnel);

        await proxy.finished;
        await new Promise((resolve) => setTimeout(resolve, 50));

        // The close handler also reports, so that a connection dropped mid-flight is
        // still accounted for; it must not add a second line to a request that answered.
        expect(reported).toHaveLength(1);
        expect(reported[0]?.statusCode).toBe(200);

        proxy.server.close();
    });
});
