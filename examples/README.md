# Examples

Two minimal applications, one per bundler plugin. They exist to be run: the plugins are
the part of this package that nothing else exercises, and a peer range in `package.json`
is a claim about a bundler version rather than evidence.

```bash
export ACC_DEV_TUNNEL_TOKEN=<jwt>
export ACC_DEV_TUNNEL_VHOST=example.com
export ACC_DEV_TUNNEL_VARIANT=DEV_1

cd vite-app && npm install && npm run dev
```

| | Port | |
|---|---|---|
| [vite-app](./vite-app) | chosen by Vite | the plugin reads it off the dev server |
| [webpack-app](./webpack-app) | 8080 | the plugin has to be told the port, and the dev server the vhost |

See the [Vite](../README.md#vite) and [webpack](../README.md#webpack) sections of the main
README for what each plugin does and why the dev server has to be told about your vhost.

The end-to-end suite runs both of these against a deployed environment.
