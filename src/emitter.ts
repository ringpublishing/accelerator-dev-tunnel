import { EventEmitter } from 'node:events';
import type { Tunnel, TunnelEvents, TunnelStats } from './types.js';

const EMPTY_STATS: TunnelStats = {
    pool: { hits: 0, misses: 0, idle: 0, target: 0, supported: false }
};

export class TunnelEmitter extends EventEmitter implements Tunnel {
    private _stopFn: (() => void | Promise<void>) | undefined;

    private _statsFn: (() => TunnelStats) | undefined;

    constructor() {
        super();
        // Prevent Node's "Unhandled 'error' event" crash.
        // Errors can be emitted during initial connection (before the caller
        // has had a chance to attach listeners after createTunnel resolves).
        // User-attached listeners still fire normally alongside this no-op.
        this.on('error', () => { /* noop */ });
    }

    /** @internal */
    public _setStopFn(fn: () => void | Promise<void>): void {
        this._stopFn = fn;
    }

    /** @internal */
    public _setStatsFn(fn: () => TunnelStats): void {
        this._statsFn = fn;
    }

    public stats(): TunnelStats {
        return this._statsFn ? this._statsFn() : EMPTY_STATS;
    }

    public async stop(): Promise<void> {
        if (this._stopFn) {
            await this._stopFn();
        }
    }

    // Typed overrides for type-safety
    public override on<E extends keyof TunnelEvents>(event: E, listener: (...args: TunnelEvents[E]) => void): this {
        return super.on(event, listener as (...args: unknown[]) => void);
    }

    public override emit<E extends keyof TunnelEvents>(event: E, ...args: TunnelEvents[E]): boolean {
        return super.emit(event, ...(args as unknown[]));
    }

    public override off<E extends keyof TunnelEvents>(event: E, listener: (...args: TunnelEvents[E]) => void): this {
        return super.off(event, listener as (...args: unknown[]) => void);
    }
}

// ── Constants ────────────────────────────────────────────────────────
