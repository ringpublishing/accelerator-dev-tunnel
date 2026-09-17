/* eslint-disable no-console */
import type { Compiler } from 'webpack';
import { createTunnel, formatRequestLine, type Tunnel, type TunnelOptions } from '../index.js';

/**
 * webpack plugin that starts a Ring Accelerator dev-tunnel after the first
 * emit and shuts it down on compiler shutdown.
 */
export class webpackPlugin {
    public static readonly pluginName = 'AccDevTunnelPlugin';

    private options: TunnelOptions;

    private tunnel: Tunnel | undefined;

    private started = false;

    constructor(options: TunnelOptions) {
        this.options = options;
    }

    public apply(compiler: Compiler): void {
        compiler.hooks.afterEmit.tapPromise(webpackPlugin.pluginName, async () => {
            if (this.started) {
                return;
            }

            try {
                this.tunnel = await createTunnel(this.options);
                this.started = true;

                console.log(
                    `[acc-dev-tunnel] connected to ${this.options.vhost}::${this.options.variant}`
                );

                this.tunnel.on('response', (info) => {
                    console.log(`[acc-dev-tunnel] ${formatRequestLine(info)}`);
                });

                this.tunnel.on('error', (err) => {
                    console.error(`[acc-dev-tunnel] ${err.message}`);
                });

                this.tunnel.on('reconnect', (attempt) => {
                    console.warn(`[acc-dev-tunnel] reconnecting... (attempt ${attempt})`);
                });

                this.tunnel.on('connect', () => {
                    console.log('[acc-dev-tunnel] control connection re-established');
                });
            } catch (err) {
                console.error(
                    `[acc-dev-tunnel] ${err instanceof Error ? err.message : String(err)}`
                );
            }
        });

        compiler.hooks.shutdown.tapPromise(webpackPlugin.pluginName, async () => {
            if (this.tunnel) {
                await this.tunnel.stop();
                this.tunnel = undefined;
            }
        });
    }
}
