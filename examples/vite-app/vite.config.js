import { defineConfig } from 'vite';
import { vitePlugin as accDevTunnel } from '@ringpublishing/accelerator-dev-tunnel/vite';

// The tunnel starts with the dev server and stops with it. The port is not configured:
// the plugin reads it off the server once it is listening, which is the whole point of
// using the plugin rather than the CLI alongside it.
export default defineConfig({
    plugins: [
        accDevTunnel({
            token: process.env.ACC_DEV_TUNNEL_TOKEN,
            vhost: process.env.ACC_DEV_TUNNEL_VHOST,
            variant: process.env.ACC_DEV_TUNNEL_VARIANT
        })
    ]
});
