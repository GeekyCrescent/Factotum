# 19. Two hosts: declared peers, a proxy rather than CORS, and a push relay

**Status:** accepted

## Context

The owner runs factotum on two machines: a Mac that sleeps and a Linux box that does not. Each
one has its own projects and its own clones, and each can launch agents. Until now each was a
separate app on the phone, with its own origin, its own service worker and its own push
subscription — so a notice from one never showed up in the other, and with the Mac asleep its app
did not open at all.

What one app needs from two daemons:

- **one origin.** A service worker, a push subscription and an IndexedDB belong to one origin.
  The phone can hold exactly one subscription per origin (`enablePush`, `apps/web/src/push.ts`), and
  the pending answers are kept in that origin's IndexedDB (ADR-0010);
- **the other host's screens, reachable from it**, with the same rules as this host's;
- **the other host's notices, delivered to the phone** that is subscribed to this host only.

Two shapes were weighed:

| Shape | Why not |
|---|---|
| CORS: the app calls the other origin directly | Two origins in one PWA: two service workers, two subscriptions (which the phone cannot hold for one app), `OPTIONS` answered everywhere in the kernel, and an origin policy that has to accept a second origin on every route. It changes the one rule this project is built on |
| **A proxy in the daemon that serves the app** | The browser sees one origin. The origin policy does not change. The other daemon is called the way a supervisor calls it: without `Origin` |

## Decision

### Peers are declared, never discovered

```jsonc
// ~/.factotum/prod/config.json on omarchy
"peers": [{ "origin": "https://juans-macbook-pro.tailbd0167.ts.net:8443" }]
```

- `peers` is optional and defaults to `[]`. **Without peers the daemon does exactly what it did**:
  `/hosts` lists only itself, `/peers/*` is 404, and so is the relay.
- At most one peer. A peer's origin passes **the same canonical-origin rule as `publicOrigin`**,
  reused rather than copied (`isCanonicalOrigin`, `packages/core/src/config.ts`), with its own message.
  And it must be `https:` unless its host is loopback (`127.0.0.0/8`, `::1`, `localhost`): the proxy and
  the relay carry everything to it, and two loopback daemons over `http:` is what the tests pair
  (security review, 2026-10-08).
- A peer's name is `machineName(origin)`, the first label of its hostname (`net/peers.ts`, the one
  place it is computed). The boot **aborts** — config errors on the network surface abort, they do not
  degrade (ADR-0004) — when the peer is this host's own `publicOrigin`, shares this host's name, or has
  a name a path could not carry (`peer-invalid`: it must match `^[a-z0-9-]+$`).
- **The kernel probes it**: `GET <origin>/health` every 15 s, with a 3 s timeout, on timers the kernel
  owns and releases in `BootHandle.stop`. Two failed probes in a row mark it unreachable; one success
  brings it back. The log gets a line on each change, never on a repeat.
- `GET /hosts` lists this host and the peer, with `reachable` and `lastSeenAt` (`null` for a peer never
  seen). Names, reachability and a time: no origin, no version, no count.

### The order of `handle()`

```
1  GET /health                                           not behind the origin (as before)
2  GET static, unless isKernelApiPath(path)             /push, /push/*, /hosts, /peers, /peers/*
3  POST /push/relay → 503 if not ready, then the relay   BEFORE the origin: its rule is the opposite
4  originAllowed → 403                                   (as before)
5  not ready → 503                                       (as before)
6  GET /hosts
7  /peers, /peers/<name>/… → the proxy
8  /modules, the push routes, the modules               (as before)
```

**The static exclusion is by exact prefix** (`isKernelApiPath`, `http/server.ts`). The static site
answers `index.html` to any GET it does not exclude, so without it `/hosts` and `/peers/*` would
answer 200 HTML, above the 403. `/hostsx` and `/peersx` stay the client's.

**The proxy is one more API route, behind the origin check and the 503.** An unknown `Origin` gets
403 and the peer receives nothing. **The relay is the only route with the opposite rule**, and it is
why it sits above the origin check: it accepts only requests **without** `Origin`. A daemon never
sends one — measured, Node's `fetch` adds none — and a browser always does.

### The proxy (`http/proxy.ts`)

**It is not an open proxy.** It goes to the declared peer only, on the routes `peers.url()` allows,
to a URL that function built.

- **`url()` reads the raw `req.url`**, never the normalised and decoded path `handle()` dispatches on.
  So a `%3F` never becomes a query and a `%2e` never becomes a dot. The prefix is read raw too:
  `/peers/m%61c/…` does not resolve to `mac`. What may follow is `/modules/<id>/…` or `/health`, with
  no dot segments, no empty segment, no backslash and no `%2e`, `%2f` or `%5c` in the path (a `%2F` in
  the **query** passes: a search for text with a `/`). The URL is built with `new URL` and kept only
  if its origin is **string-identical** to the peer's. It is the only place an outgoing URL is built.
- **It never follows a redirect.** A 3xx from the peer arrives as 502.
- **Only `GET`, `HEAD` and `POST` travel**, the methods the modules' routes use. Anything else is 404
  without calling the peer.
- **Headers, by allow-list, both ways:**

  | Way | Headers |
  |---|---|
  | Out | `content-type`, `accept`, and `content-length` **only when a body is sent**. Plus `accept-encoding: identity` |
  | Back | `content-type`, `cache-control`, `content-disposition`, `content-security-policy`, `x-content-type-options` |

  Never `Origin`, `Cookie`, `Host` or `Forwarded`, and nothing `tailscale serve` adds. The last three
  coming back are `serve-file.ts`'s containment headers, and **containment is never the peer's to
  decide**: `x-content-type-options: nosniff` and `content-security-policy: default-src 'none';
  sandbox` are forced on every proxied response. **The `content-type` is rebuilt, never passed
  through**: only a single `type/subtype` with no comma is believed, because `application/json,
  text/html` reads as JSON to one parser and as HTML to a browser that takes the last type. JSON
  goes out as exactly `application/json`; the four raster types `rasterTypeOf` paints go out as
  their bare type and stay inline (the chat shows them in an `<img>`), keeping the peer's
  disposition for the file name; anything else, an unparseable type included, goes out as
  `application/octet-stream` with `content-disposition: attachment`, overriding whatever the peer
  sent. **`content-length` does not come back**: the body goes out chunked,
  so a peer that compressed could never leave the length disagreeing with the bytes. A GET that
  announced a length would leave the peer waiting for bytes that never come, and on a kept-alive
  connection read the next request as its body; so `content-length` goes out only with a body, and
  `strictContentLength` turns a body that does not match it into an error.
- **Timeouts**, on the kernel's timers. The fixed bound covers the wait for the response **headers**;
  after them, `PROXY_IDLE_TIMEOUT_MS` (30 s) is the longest silence between two chunks of the body, so a
  download that keeps flowing is never cut and one that stalls is (code review, 2026-10-08):

  | Request | Constant | Value | Why |
  |---|---|---|---|
  | `GET`, `HEAD` | `PROXY_TIMEOUT_MS` | 10 s | reads |
  | `POST` JSON | `PROXY_POST_TIMEOUT_MS` | 60 s | a launch runs git inside the request: `status`, `fetch`, `rev-list` and `merge` are 33 s at worst |
  | Any other `POST` | `PROXY_UPLOAD_TIMEOUT_MS` | 120 s | uploads. A `POST` with no `content-type` counts as one: a `File` with no type is sent that way |

  An upload cut by its bound while the browser is still sending gets a reset, not the 502: the rest of
  its body is never read. Accepted (code review, 2026-10-08): the client already treats a failed upload
  as failed, and reading the rest to answer politely is the unbounded read `body.ts` exists to avoid.

  A peer marked unreachable, or one that does not answer in time, is **502 `peer-unreachable`** with its
  name. **A 502 after a `POST` does not say whether the peer did it**, so the client never retries a
  launch that got one: it says the other host may have started it, and refreshes that host's list.
- **It uses `node:http`'s `request`, not `fetch`.** Measured on Node 26.3 (undici 8.3): `fetch` reads a
  streamed request body as fast as it can, whatever the socket says. A 50 MB upload went through and sat
  in memory whole — with `Readable.toWeb`, an async iterable or a pull stream alike, with or without
  `content-length`. Piped through `request`, the same upload peaked at about 2 MB. Bodies stream both
  ways; the peer applies its own body cap. `BootHandle.stop` aborts every proxied request before
  closing the server, so an upload to a sleeping peer cannot hold the shutdown for two minutes.
- **The log carries the route's shape, never the route**: `proxy <method> <peer> /modules/<id>/… →
  <status> <ms>`, or `proxy <method> refused → 404`. The capability tokens of `sessions` travel **in
  the path** (`asks/:askId`, `grants/:token`, `questions/:token`, `uploads/:uploadId/:name`), so logging
  the whole path would put every `ask` of the other host answered from here into this host's log. Never
  a body, and never an error's message: it carries the URL.

### The push relay (`push/relay.ts`)

The phone is subscribed to **one** host. A notice raised on the other is handed over:

```
Mac:   ctx.notify.send(msg)
         ├─► its own devices, if it has any
         └─► if the peer is reachable and has devices: POST <peer>/push/relay { message, moduleId, machine }
Linux: POST /push/relay
         503 before READY · 403 relay-refused with any Origin · 404 with no peers
         429 relay-refused past 20 a minute · 413 over 8 KiB
         400 for a body that is not a notice · 403 relay-refused for a machine that is not the peer's name
         → 202, and delivered to its own devices
```

- **The machine is kept.** `relay` is not `send`: `send` stamps this host's name, and the title the
  service worker paints would read `omarchy: …` for a notice from the Mac. `relay` delivers the
  envelope with the peer's `machine`, already checked against the declared peer.
- **The path is rewritten under `/h/<machine>`**, and `data.host` is set **last**, over anything the
  peer put there. A tap opens the peer's screen inside this host's app, through the proxy, and a stored
  pending knows which host it belongs to. The path is validated before it is prefixed: absolute, not
  protocol-relative, no dot segments, backslashes or escapes of them, no whitespace or control
  characters — so it cannot climb out of `/h/<machine>`. Unknown keys are dropped.
- **A relayed notice is never forwarded again.** Only `send` forwards.
- **The cap of ADR-0008 is checked after `data.host` is added.** A notice over it goes without its
  `data`, and the log says so — naming the machine only, since `data` can carry a token.
- **It answers 202 without waiting** for the push services. The sender gives up after
  `PUSH_RELAY_TIMEOUT_MS` (5 s, on the kernel's timers), and a slow phone must not turn a delivered
  notice into a failure on the other side. `settled()` covers it at shutdown.
- **`send` forwards independently of this host's own devices.** Once the phone subscribes to the other
  host only, this one has none, and the old early return on zero devices would have stopped the
  forward for ever. The forward needs no keys either, so a host whose push is off still forwards; it
  only cannot receive.
- **`canReach()` is true with devices here, or with a reachable peer that has some** by its last probe.
  It stays synchronous, so the permission gate still decides at once (ADR-0009). That is what
  `devices` on `/health` is for.

### `ctx.peers`: a module talks to its twin (corte 2)

The second part of the spec gave `ModuleContext` its **eighth field**, `peers: PeerCaller`, with one
consumer: moving sessions between hosts (ADR-0020). It is the same move as `notify` (ADR-0008) — one
narrow field, the module's id bound by the registry — and the precedent it follows is that one:

- **A module names a peer and a path relative to itself.** The kernel builds
  `/modules/<this module's id>/<path>` through `peers.url()`, so the proxy's rules hold: only
  `/modules/<id>/…`, no dot segments or escapes, and the URL compared to the peer's origin by exact
  equality. A path that would leave answers `refused` **before anything leaves the host**. A module is
  never given a URL, a socket, or another module's routes.
- **`json` and `upload` both go through `send()`** (`net/peer-http.ts`), the proxy's streamed request on
  `node:http`: an upload takes a **path**, never a stream (ADR-0012), and the kernel opens the file and
  closes it whatever happens. A 100 MB file goes up with the live memory under 64 MB (measured in the
  tests). The design had `json` on `fetch`; one path means one reader of the answer and one way to fail.
- **The timeout is the kernel's**: 10 s by default, at most `PEER_CALL_MAX_MS` (300 s, Node's
  `requestTimeout`, which the peer's server does not change). A `timeout` **does not say** whether the
  peer did the work; the caller decides (ADR-0020 does, by asking).
- **It never throws.** Every way a call goes wrong is a `reason`: `unreachable` (not declared, down by
  the probe, or the connection failed), `refused`, `timeout`, `bad-json` (a 2xx that is not JSON or is
  over `MAX_BODY_BYTES`), `http` — with the peer's JSON body, so a module can read its own refusals.
  The kernel never interprets that body.
- **`BootHandle.stop` aborts the calls in flight** before the kernel's timers are disposed. That order
  is load-bearing, measured in red: without the abort, disposing the timers cancels the call's own
  deadline, and a call to a sleeping peer never ends.
- **The log carries the shape of the route only**: `peers <method> <peer> /modules/<id>/… → <status>`,
  like the proxy. A refused path is logged without peer or path: it is the module's, and may carry a token.

The calls are built by `boot` as a service (`createPeerCalls`, on the peer table and the kernel's
timers) and handed to the registry, which binds each module's id onto it — the shape `push` already
has, rather than the `RelayPeers` the design first proposed for the registry.

## Consequences

- **Anyone on the tailnet can post a notice to the phone** by naming the peer in the body. The relay
  refuses browsers and machines that are not the peer, and that is all it can do: behind
  `tailscale serve` every request arrives from `127.0.0.1`, so the source address says nothing. It is
  the model of ADR-0002 — whoever is on the tailnet can already launch agents.
- **The `Host` / DNS-rebinding gap now reaches the peer.** `docs/networking.md` declares that `Host` is
  not checked. Through the proxy, what sits behind that gap on this host includes everything the other
  host's modules serve.
- **A compromised peer cannot serve a document under this host's origin**: the proxy forces the
  containment headers above (security review, 2026-10-08). What it can still serve is JSON to `fetch`
  and a raster image, which is what the modules' routes answer anyway.
- **The relay is throttled and its body is bounded** (security review, 2026-10-08): a token bucket of
  20 a minute on an injected clock (no timer to own), charged only for a notice that passed, so garbage
  cannot starve the peer's; a body cap of
  8 KiB (`RELAY_MAX_BODY_BYTES`), not the API's 1 MiB; caps per field; `moduleId` a module id. **`data`
  is module-defined, so the kernel bounds its shape rather than its keys**: flat, scalar values only
  (the questions notice carries `count` as a number), at most 16 short keys and 1536 bytes. Whoever
  names the peer can still push, but 20 a minute of short text, not a flood.
- **`/health` now says `devices`**, a count, without the origin check — like `version` and `ready`
  already were.
- **At most 32 proxied requests in flight** (`PROXY_MAX_IN_FLIGHT`, security review, 2026-10-08); past
  it, 503 `peer-unreachable` without calling the peer. It bounds the sockets and timers one host holds
  open towards the other.
- **The probe and the relay still use `fetch`.** Their bodies are small; backpressure is the
  proxy's problem only.
- **Each host needs Tailscale DNS on** (`tailscale set --accept-dns=true`). Without it `*.ts.net` does
  not resolve, and the probe, the proxy and the relay fail. Measured on the Mac. `factotum doctor` says
  so, with that command.

## What this does not do

- Discover peers, or take more than one.
- Move a session from one host to the other: that is ADR-0020, built on `ctx.peers`.
- Let a module call **another** module on the peer, or anything that is not `/modules/<its own id>/`.
