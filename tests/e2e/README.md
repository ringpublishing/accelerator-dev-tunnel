# End-to-end suite

`npm run test:e2e` drives the real client through a deployed environment, with the
fixture server running in the test process. Assertions are made from the public side:
the test asks the vhost for something and checks what comes back, which exercises every
hop in one shot.

It is excluded from `npm test` and from CI, because it needs the branch deployed first
and it serialises globally: a variant accepts one control connection, so two runs
against the same variant evict each other.

## Configuration

```bash
export E2E_VHOST=<vhost carrying the dev-tunnel variant>
export E2E_VARIANT=DEV_1
export E2E_TOKEN=<JWT for that variant>
export E2E_ENDPOINT_PRIMARY=<Accelerator entry point to drive>
export E2E_ENDPOINT_SECONDARY=<a second entry point, for the routing cases>
export E2E_TLS=true
export E2E_CA_FILE=<PEM to trust, if the vhost has a self-signed certificate>
npm run test:e2e
```

Keep the endpoints in a local env file rather than here.

## Why the entry point is given explicitly

The suite connects to the entry point directly and sets `Host` and the TLS SNI to the
vhost, so the target is chosen per connection rather than by DNS. The vhost never has to
resolve at all, and one run can register a tunnel through one entry point and assert
against another.

**Set `E2E_ENDPOINT_SECONDARY`.** Without it the routing cases skip themselves, and they
are the ones proving that a tunnel is reachable from more than the entry point it
registered through. Everything else stays green while that is broken, which is exactly
how it once stayed broken unnoticed.

The two endpoints have to be genuinely different entry points; two addresses that lead
to the same place prove nothing.

## What it covers

Response integrity (chunked bodies, large bodies, SSE timing, duplicate `Set-Cookie`,
hop-by-hop stripping), content negotiation across brotli/gzip/identity, WebSocket
passthrough, concurrency and slot release under a saturating burst, failure modes
(unreachable application, malformed headers, status passthrough), tunnel lifecycle
across client restarts and takeovers, a page-load waterfall over HTTP/1.1 keep-alive and
a multiplexed HTTP/2 session, and routing across entry points.
