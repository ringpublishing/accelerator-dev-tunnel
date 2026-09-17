import type { Plugin, ViteDevServer } from 'vite';
import { createTunnel, formatRequestLine, type Tunnel, type TunnelOptions } from '../index.js';

export type VitePluginOptions = Omit<TunnelOptions, 'port'> & {
    /** Override port (by default inferred from Vite dev server) */
    port?: number;
};

/**
 * Vite plugin that starts a Ring Accelerator dev-tunnel when the dev server
 * starts and tears it down on shutdown.
 */
export function vitePlugin(options: VitePluginOptions): Plugin {
    let tunnel: Tunnel | undefined;

    return {
        name: 'acc-dev-tunnel',
        apply: 'serve',

        /**
         * Let the dev server answer requests addressed to the vhost.
         *
         * Vite refuses any request whose `Host` is not in `server.allowedHosts`, and a
         * tunnelled request arrives addressed to the vhost by definition — so without
         * this every single one comes back `403 Blocked request`, which reads like a
         * broken tunnel rather than a dev server doing what it was told.
         */
        config(userConfig): any { // eslint-disable-line @typescript-eslint/no-explicit-any
            if (userConfig.server?.allowedHosts === true) {
                // Already permissive; narrowing it to one name would be a downgrade.
                return undefined;
            }

            return { server: { allowedHosts: [options.vhost] } };
        },

        configureServer(server: ViteDevServer): void {
            const httpServer = server.httpServer;

            if (!httpServer) {
                // Vite runs in middleware mode, where it owns no HTTP server and there
                // is no port to tunnel to. Returning quietly would leave the developer
                // with a plugin that is configured, loaded, and silently doing nothing.
                server.config.logger.warn(
                    '[acc-dev-tunnel] no dev server to tunnel: Vite is in middleware mode. '
                    + 'Start the tunnel against your own server instead — the CLI, or createTunnel({ port }).'
                );

                return;
            }

            httpServer.once('listening', async (): Promise<void> => {
                const address = httpServer.address();
                const port
                    = options.port
                    ?? (address && typeof address === 'object' ? address.port : undefined);

                if (!port) {
                    server.config.logger.error(
                        '[acc-dev-tunnel] Could not determine dev server port. '
                        + 'Pass `port` explicitly to the plugin.'
                    );

                    return;
                }

                try {
                    tunnel = await createTunnel({ ...options, port });
                    server.config.logger.info(
                        `[acc-dev-tunnel] connected to ${options.vhost}::${options.variant}`
                    );
                    server.config.logger.info(
                        `[acc-dev-tunnel] no traffic reaches ${options.variant} until you force it: `
                        + '"Force as current for me" in the Accelerator panel, or send '
                        + `x-oa-variant: ${options.vhost}::${options.variant}`
                    );

                    tunnel.on('response', (info) => {
                        server.config.logger.info(`[acc-dev-tunnel] ${formatRequestLine(info)}`);
                    });

                    tunnel.on('error', (err) => {
                        server.config.logger.error(`[acc-dev-tunnel] ${err.message}`);
                    });

                    tunnel.on('reconnect', (attempt) => {
                        server.config.logger.warn(
                            `[acc-dev-tunnel] reconnecting... (attempt ${attempt})`
                        );
                    });

                    tunnel.on('connect', () => {
                        server.config.logger.info(
                            '[acc-dev-tunnel] control connection re-established'
                        );
                    });
                } catch (err) {
                    server.config.logger.error(
                        `[acc-dev-tunnel] ${err instanceof Error ? err.message : String(err)}`
                    );
                }
            });

            // Cleanup on server close
            const originalClose = server.close.bind(server);

            server.close = async (): Promise<void> => {
                const currentTunnel = tunnel;

                tunnel = undefined;

                if (currentTunnel) {
                    await currentTunnel.stop();
                }

                await originalClose();
            };
        }
    };
}
