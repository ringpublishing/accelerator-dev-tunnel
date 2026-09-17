# @ringpublishing/accelerator-dev-tunnel

Receive real [Ring Accelerator](https://ringpublishing.com) traffic on your local machine — without exposing any public infrastructure. A developer-facing alternative to ngrok, built into the Accelerator variant system.

When you configure a variant as `dev-tunnel`, all traffic hitting that variant is forwarded to your local HTTP server. You get real request headers, real Ring context, and real SSL termination — exactly as in production.

---

## Requirements

- A Ring Accelerator vhost with a variant configured as `dev-tunnel`
- A JWT token for that variant — see
  [Dev tunnel](https://developer.ringpublishing.com/docs/Accelerator/topics/development/dev-tunnel/index.html)
  in the Accelerator documentation for how to create the variant and obtain the token
- Node.js 20 or newer

---

## Which integration

| You have | Use | Why |
|---|---|---|
| A Vite app | [Vite plugin](#vite) | Starts and stops with the dev server, and finds its port for you |
| A webpack app | [webpack plugin](#webpack) | Starts and stops with the build |
| Anything else | [CLI](#cli) | Any local HTTP server, whatever it is written in |
| Your own tooling | [Node.js API](#nodejs-api) | The plugins and the CLI are built on it |

Everything below shares one set of options; each section lists what it names them.

---

## Vite

```bash
npm install --save-dev @ringpublishing/accelerator-dev-tunnel
```

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { vitePlugin as accDevTunnel } from '@ringpublishing/accelerator-dev-tunnel/vite'

export default defineConfig({
  plugins: [
    accDevTunnel({
      token: process.env.ACC_DEV_TUNNEL_TOKEN,
      vhost: 'example.com',
      variant: 'DEV_1',
    }),
  ],
})
```

The tunnel starts with the dev server and stops with it. The port is not configured — the
plugin reads it off the dev server once it is listening; pass `port` to override.

Browser WebSocket connections are tunnelled automatically, so hot reload works.

The plugin also adds your vhost to `server.allowedHosts`. Vite answers any request whose
`Host` it does not recognise with `403 Blocked request`, and a tunnelled request is
addressed to the vhost by definition — so without that, every request would be refused by
the dev server itself.

Takes the same options as [`createTunnel`](#options), minus `port`.
A runnable example is in [`examples/vite-app`](./examples/vite-app), driven by the end-to-end suite.

---

## webpack

```bash
npm install --save-dev @ringpublishing/accelerator-dev-tunnel
```

```js
// webpack.config.js
const { webpackPlugin: AccDevTunnelPlugin } = require('@ringpublishing/accelerator-dev-tunnel/webpack')

const PORT = 8080

module.exports = {
  devServer: {
    port: PORT,
    // Required: tunnelled requests arrive addressed to the vhost, and
    // webpack-dev-server answers anything else with `403 Invalid Host header`.
    allowedHosts: ['example.com'],
  },
  plugins: [
    new AccDevTunnelPlugin({
      token: process.env.ACC_DEV_TUNNEL_TOKEN,
      vhost: 'example.com',
      variant: 'DEV_1',
      port: PORT,
    }),
  ],
}
```

Two things differ from Vite. The port has to be given, because the plugin applies to the
compiler and never sees the dev server. `allowedHosts` has to be set for the same reason —
the plugin cannot do it for you.

Takes the same options as [`createTunnel`](#options).
A runnable example is in [`examples/webpack-app`](./examples/webpack-app), driven by the end-to-end suite.

---

## CLI

```
$ npx @ringpublishing/accelerator-dev-tunnel setup
[acc-dev-tunnel] Interactive setup — configuration will be saved to ~/.ring/accelerator-dev-tunnel.json

JWT token: eyJhbG...
Vhost (e.g. example.com): example.com
Variant (e.g. DEV_1): DEV_1
Local port [80]: 3000
Local host [127.0.0.1]:
Use HTTPS (wss://)? [yes]:
[acc-dev-tunnel] Saved tunnel configuration for example.com DEV_1

$ npx @ringpublishing/accelerator-dev-tunnel start
[acc-dev-tunnel] using the only saved configuration: example.com DEV_1
[acc-dev-tunnel] connected to example.com::DEV_1
[acc-dev-tunnel] 2026-05-29 09:15:22 GET / → 200 11ms 203.0.113.10
[acc-dev-tunnel] 2026-05-29 09:15:23 GET /assets/main.js → 200 4ms 203.0.113.10
```

Non-interactive configuration:

```bash
npx @ringpublishing/accelerator-dev-tunnel config set example.com DEV_1 --token <jwt> --port 3000
```

### Commands

| Command | Description |
|---|---|
| `start [<vhost> <variant>]` | Start a dev-tunnel connection |
| `check [<vhost> <variant>]` | Diagnose a tunnel without starting one |
| `setup` | Interactive configuration wizard |
| `config list` | List saved tunnel configurations |
| `config get <vhost> <variant>` | Show a tunnel configuration |
| `config set <vhost> <variant>` | Save a tunnel configuration |
| `config remove <vhost> <variant>` | Remove a saved tunnel configuration |

With exactly one saved configuration, `start` and `check` need no arguments. Every command
answers `--help`.

### `start` options

Connection parameters come from the config file; flags override them.

| Flag | Environment variable | Description | Default |
|---|---|---|---|
| `--token <jwt>` | `ACC_DEV_TUNNEL_TOKEN` | JWT for the variant | from config |
| `--host <host>` | — | Local host to forward to | `127.0.0.1` |
| `--port <port>` | — | Local port to forward to | `80` |
| `--idle-timeout <sec>` | — | Exit after N seconds of inactivity (max 86400) | `14400` |
| `--proxy <host[:port]>` | `ACC_DEV_TUNNEL_PROXY` | Reach Accelerator at this address instead of resolving the vhost | — |
| `--no-ssl` | — | Use `ws://` instead of `wss://` | `false` |
| `--ca <file>` | — | Trust an extra certificate (PEM), for a vhost with a self-signed one. Verification stays on | — |
| `--insecure-tls` | — | Turn certificate verification off entirely. Prefer `--ca` | `false` |

With `--proxy` the connection goes to that address while `Host` and the TLS SNI still name
the vhost. Use it when the vhost does not resolve from your network, or to reach Accelerator
through a specific entry point.

`config set` takes `--token`, `--host`, `--port`, `--no-ssl`, `--ca` and `--insecure-tls`
and saves them.

### Configuration file

`~/.ring/accelerator-dev-tunnel.json`, written owner-only because it holds tokens.

```json
{
  "tunnels": {
    "example.com": {
      "DEV_1": { "token": "<your-jwt-token>", "port": 3000, "host": "127.0.0.1" }
    }
  }
}
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean exit (idle timeout, SIGTERM, server shutdown) |
| `1` | Could not run — auth failure, takeover, or an unreachable Accelerator |
| `2` | Wrong usage — a missing argument or an unknown flag |

### Running alongside a dev server

```json
{
  "scripts": {
    "dev": "vite",
    "tunnel": "npx @ringpublishing/accelerator-dev-tunnel start example.com DEV_1",
    "dev:tunnel": "concurrently \"npm run dev\" \"npm run tunnel\""
  }
}
```

Without the plugin, the dev server's host check is yours to configure — see the
[Vite](#vite) and [webpack](#webpack) sections for what each of them refuses and why.

---

## Node.js API

```ts
import { createTunnel } from '@ringpublishing/accelerator-dev-tunnel'

const tunnel = await createTunnel({
  token: process.env.ACC_DEV_TUNNEL_TOKEN,
  vhost: 'example.com',
  variant: 'DEV_1',
  port: 3000,
})

tunnel.on('response', ({ method, path, statusCode, durationMs }) => {
  console.log(`${method} ${path} → ${statusCode} ${durationMs}ms`)
})

tunnel.on('disconnect', (reason) => console.log('disconnected:', reason))
tunnel.on('error', (err) => console.error(err.message))

await tunnel.stop()
```

`createTunnel` resolves once the tunnel is connected and ready to receive traffic, and
rejects if authentication fails — `AuthError` and `TakeoverError` are exported so you can
tell a bad token from someone else claiming the variant.

Events: `connect`, `disconnect`, `reconnect`, `request`, `response`, `error`.

### Options

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `token` | `string` | yes | — | JWT for the variant |
| `vhost` | `string` | yes | — | Accelerator vhost, e.g. `example.com` |
| `variant` | `string` | yes | — | Variant name, e.g. `DEV_1` |
| `port` | `number` | * | `80` | Local port to forward to |
| `host` | `string` | * | `127.0.0.1` | Local host to forward to |
| `idleTimeout` | `number` | no | `14400` | Seconds of inactivity before exit (max 86400) |
| `maxReconnectAttempts` | `number` | no | `0` | `0` retries indefinitely |
| `proxy` | `string` | no | — | Reach Accelerator at `<host>` or `<host>:<port>` instead of resolving the vhost |
| `noSsl` | `boolean` | no | `false` | Use `ws://` instead of `wss://` |
| `ca` | `string \| string[]` | no | — | Extra certificate to trust, as PEM. Verification stays on |
| `insecureTls` | `boolean` | no | `false` | Turn certificate verification off entirely. Prefer `ca` |

\* At least one of `port` or `host` must be given.

---

## Seeing your traffic

A development variant is never in traffic, so a connected tunnel stays idle until you ask
for that variant explicitly: **Force as current for me** in the Accelerator UI, the
bookmarklet, or the `x-oa-variant: <vhost>::<VARIANT>` header for server-to-server calls.
See [Development variant](https://developer.ringpublishing.com/docs/Accelerator/topics/development/development-variant/index.html)
in the Accelerator documentation.

---

## Troubleshooting

Start with `acc-dev-tunnel check`, which reports on each part of the path separately:

```
[acc-dev-tunnel] checking example.com::DEV_1
[acc-dev-tunnel]   ✓ configuration  ~/.ring/accelerator-dev-tunnel.json
[acc-dev-tunnel]   ✓ token          valid for 29d11h
[acc-dev-tunnel]   ✗ local app      nothing listening on 127.0.0.1:3000 — start it, or pass --port
[acc-dev-tunnel]   ✓ accelerator    tunnel established via example.com
[acc-dev-tunnel] 1 problem found
```

**`403 Blocked request` / `403 Invalid Host header`**
Your dev server is refusing the vhost. See [Vite](#vite) or [webpack](#webpack).

**`token_expired` / `token_mismatch`**
The token expired, or a newer one was issued for the variant. Reset it in the Accelerator UI.

**`TLS connection failed`**
The vhost must serve HTTPS with a certificate the client trusts. For a self-signed one,
pass `--ca`.

**The browser shows production content**
Nothing forces the variant — see [Seeing your traffic](#seeing-your-traffic).

**A request returns 502 while the tunnel stays connected**
Your local application is not answering. The tunnel is fine; the request is not.

**The tunnel was taken over**
One connection per variant. A second client replaces the first, which exits reporting a
takeover. Use separate variants for parallel work.

---

## License

MIT
