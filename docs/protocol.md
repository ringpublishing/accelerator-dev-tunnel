# Tunnel protocol — client side

What this client sends and expects. The counterpart is the dev tunnel proxy, which
documents the same contract from its side; a change to either has to land on both.

## Connections

The client opens two kinds of WebSocket, both to the vhost, both through the normal
Accelerator edge:

| | Path | Lifetime |
|---|---|---|
| Control | `/__acc/dev-tunnel/register` | Long-lived, one per tunnel |
| Data | `/__acc/dev-tunnel/data` | One per request, opened on demand |

With `--proxy` the TCP connection goes to the given host while `Host` and the TLS SNI
still name the vhost, so the tunnel reaches Accelerator through a given address rather
than through whatever the vhost resolves to.

## Headers

Every connection carries `x-oa-variant: <vhost>::<VARIANT>`. The proxy splits on the
first `::`, so neither part may contain it.

A data connection also carries `x-tunnel-token` and `x-tunnel-request-id` as upgrade
headers, so the server has them before the socket opens.

## Control messages

Sent once, immediately on open:

```json
{ "type": "auth", "token": "<jwt>" }
```

Received:

| Message | Handling |
|---|---|
| `auth_ok` | Resolve `createTunnel`, arm the idle timer |
| `auth_error` | Fatal. `reason: "replaced"` becomes `TakeoverError`, everything else `AuthError` |
| `shutdown` | Exit cleanly; the server is going away |
| `open_data` | Open a data connection for that `requestId` |

`open_data` carries `requestId`, `method`, `path` and `remoteIp`; for a browser
WebSocket also `isWebSocket: true` and `headers`. Those headers are replayed to the
local WebSocket server — `Sec-WebSocket-Protocol` through ws's `protocols` argument
rather than as a header, or ws will not accept the server's selection as a match.

## Pooled data connections

A data connection normally names the request it serves in `x-tunnel-request-id`, which
means it can only be opened once that request exists — so its handshake is on the request
path.

A connection may instead be opened ahead of time with `x-tunnel-pooled: 1` and no request
id. The proxy authenticates it and parks it, holding no slot. When the client has work for
it, it sends one text frame:

```json
{ "type": "bind", "requestId": "<id>" }
```

From that frame on the connection behaves exactly like one that named its request in the
headers. The proxy closes a parked connection with `1008` if the frame is unparseable or
is not a bind, if the request it names has already timed out, or after 10 minutes unbound.

Pooling is negotiated by attempt, not by a capability flag: a proxy that does not
implement it rejects the upgrade with `1008 missing_headers`, and the client falls back to
opening connections on demand. Parked connections must be pinged — anything idle in
front of a load balancer is dropped, typically after a minute.

## Data flow

A data connection carries **raw bytes**. The client pipes them into a TCP connection to
the local application and pipes the response back untouched.

If the local application cannot be reached, the client writes a synthetic
`502 Bad Gateway` head before closing. Closing silently makes the proxy end an unwritten
response, which Node completes as an empty — and cacheable — `200`.

## Liveness

The proxy pings the control connection every 20 s, because idle connections are torn
down in transit. If no ping arrives within 60 s the client calls `terminate()` — not
`close()`, since a half-open socket will never complete a closing handshake — and the
close handler drives the reconnect.

## Reconnect

Backoff is 1 s, 2 s, 4 s, 8 s, 16 s, held at 16 s, with ±20% jitter.

Close codes `1002`, `1003` and `1008` are terminal: the server will keep refusing.
An auth timeout in particular arrives with **no** preceding `auth_error` frame, so the
close code is the only signal there is.
