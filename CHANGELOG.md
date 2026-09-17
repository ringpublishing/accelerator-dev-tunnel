# CHANGELOG
The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## 1.0.0 - 2026-09-14
### Changed
- [@mdulawa]: Public version.

## 0.3.1 - 2026-09-11
### Added
- [@alacki]: End-to-end coverage for request headers, request bodies and connections that stay quiet.

## 0.3.0 - 2026-09-06
### Added
- [@alacki]: Vite and webpack plugins, and a `check` command that says which part of a tunnel is not working.
- [@alacki]: Requests are logged with the status the local application returned.
- [@alacki]: Options for connecting through a specific entry point and for vhosts with a self-signed certificate.

### Changed
- [@alacki]: Renamed to `@ringpublishing/accelerator-dev-tunnel` and published to public npm.
- [@alacki]: Vite peer range covers 5 to 8; Vite 4 is dropped.
- [@alacki]: Errors say what to do about them rather than surfacing as unexpected failures.

### Fixed
- [@alacki]: Tunnelled requests reach Vite and webpack dev servers, which refuse an unrecognised `Host` by default.
- [@alacki]: Reconnect, WebSocket passthrough, local-connection handling and the config file all behave as documented.

## 0.2.0 - 2026-05-29
### Added
- [@alacki]: CLI commands: `setup` (interactive wizard), `start <vhost> <variant>`, `config list|get|set|remove`.
- [@alacki]: Config file (`~/.ring/accelerator-dev-tunnel.json`) for persisting tunnel settings.
- [@alacki]: Log timestamps formatted with dayjs (`YYYY-MM-DD HH:mm:ss`).

### Changed
- [@alacki]: README rewritten with shell usage examples, CLI reference, and `@accelerator/dev-tunnel-client` package name.
- [@alacki]: Token is now stored per vhost/variant in config file.

## 0.1.0 - 2026-05-27
### Added
- [@alacki]: `--proxy <host>[:<port>]` option — connect through a proxy instead of directly to the vhost; vhost is sent as `Host` header and used for TLS SNI. Port defaults to 443 (or 80 with `--no-ssl`).
- [@alacki]: `--no-ssl` option — use `ws://` instead of `wss://` for all tunnel WebSocket connections.

### Changed
- [@alacki]: `--port` now defaults to `80`; at least one of `host` or `port` must be provided in programmatic API.

## 0.0.2 - 2026-05-19
### Fixed
- [@alacki]: CLI command detection — use `positionals[0]` from `parseArgs` instead of `process.argv[2]` (flags before `start` no longer break command parsing).

## 0.0.1 - 2026-04-08
### Added
- [@alacki]: CLI tool (`acc-dev-tunnel start`) to forward Ring Accelerator dev-tunnel traffic to a local HTTP server
- [@alacki]: Programmatic API (`createTunnel`) with typed event emitter for custom integrations
- [@alacki]: Vite plugin with automatic port detection from dev server
- [@alacki]: webpack plugin with `afterEmit`/`shutdown` lifecycle hooks
- [@alacki]: WebSocket-based control connection with JWT authentication
- [@alacki]: Bidirectional raw-byte piping between Accelerator data connections and local TCP with early-data buffering
- [@alacki]: Automatic reconnection with exponential backoff (1s → 16s cap)
