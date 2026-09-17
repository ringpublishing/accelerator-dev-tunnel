const HtmlWebpackPlugin = require('html-webpack-plugin');
const { webpackPlugin: AccDevTunnelPlugin } = require('@ringpublishing/accelerator-dev-tunnel/webpack');

const PORT = 8080;

// Unlike the Vite plugin, this one cannot read the port off the dev server, so it has
// to be told — keep it in step with devServer.port below.
module.exports = {
    mode: 'development',
    entry: './main.js',
    devServer: {
        port: PORT,
        // Required, and the plugin cannot do it for you: it applies to the compiler,
        // while this is dev-server configuration. Tunnelled requests arrive addressed
        // to the vhost, and webpack-dev-server answers anything it does not recognise
        // with `403 Invalid Host header`.
        allowedHosts: [process.env.ACC_DEV_TUNNEL_VHOST]
    },
    plugins: [
        new HtmlWebpackPlugin({ template: './index.html' }),
        new AccDevTunnelPlugin({
            token: process.env.ACC_DEV_TUNNEL_TOKEN,
            vhost: process.env.ACC_DEV_TUNNEL_VHOST,
            variant: process.env.ACC_DEV_TUNNEL_VARIANT,
            port: PORT
        })
    ]
};
