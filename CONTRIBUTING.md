# CONTRIBUTING

This project is internally developed by Ring Publishing and published to npm as
`@ringpublishing/accelerator-dev-tunnel`.

## Versioning

Version follows [Semantic versioning](https://semver.org/) and is derived from the top
`## <version>` heading in `CHANGELOG.md` — `package.json` deliberately carries no
`version` field. A change with no changelog entry produces no release, so add one for
every user-visible change.

The CLI reports the same number through `--version`; `tsup.config.ts` reads it from the
changelog at build time.

## Local development

```bash
npm install
npm run lint
npm test            # vitest with coverage thresholds
```

The end-to-end suite runs separately and needs a deployed environment; see
[tests/e2e/README.md](tests/e2e/README.md).

## How the source is laid out

| | |
|---|---|
| `src/index.ts` | `createTunnel`, the entry point everything else is built on |
| `src/types.ts` | the public API surface and the tuning constants |
| `src/protocol.ts` | the wire contract with the proxy — see [docs/protocol.md](docs/protocol.md) |
| `src/errors.ts`, `src/emitter.ts` | what a caller catches, and what it listens on |
| `src/tunnel/` | the control connection, the data connections and the pool |
| `src/cli/` | argument parsing and dispatch; one module per command under `commands/` |
| `src/plugins/` | the Vite and webpack plugins |
| `examples/` | runnable applications for both plugins — see [examples/README.md](examples/README.md) |

## Before opening a pull request

- `npm run lint` and `npm test` all pass.
- A `CHANGELOG.md` entry exists under the top `## <version>` heading — add a new one when
  the version at the top has already been released.
- Coverage thresholds in `vitest.config.ts` have not been lowered to make a change
  pass. They are a ratchet — raise them when coverage improves.

## Protocol changes

The control and data WebSocket protocol is shared with the dev tunnel proxy. Any change
to the message types in `src/protocol.ts`, to the upgrade headers, or to the
close codes has to land on both sides. Note which proxy version a change requires in
the changelog entry.
