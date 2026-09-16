# Networking, and why there is no password

This is the page to read before running factotum anywhere unusual, and the page to
check when it refuses to start.

## The model, in one paragraph

factotum has **no login and no token**. It listens on **loopback only**, and
`tailscale serve` puts HTTPS in front of it on a `*.ts.net` name that only your tailnet
can resolve. Being on the tailnet is the authorisation. On top of that it checks the
`Origin` header, because reaching the address is not the same as being the client.
That is the whole of it.

This is defensible for one person on machines they own. **It stops being defensible
the moment a second person is on your tailnet**, because they can then do everything
you can — launch agents, read your repositories, write to your disk. The loopback bind
narrows this: they can no longer reach the daemon *directly*. It does not remove it.

**factotum requires Tailscale.** Not as a recommendation — as a dependency. `init`
will not write a config without a MagicDNS name, because the resulting config is one
the daemon would refuse to start on.

## Setting it up

1. [Install Tailscale](https://tailscale.com/download) on this machine and on your
   phone, and sign both into the same tailnet.
2. Enable **MagicDNS** and **HTTPS** for the tailnet, in the admin console. HTTPS is
   what lets `serve` get a certificate without you managing one.
3. Run `factotum init`. It writes a loopback bind and the public origin it read from
   `tailscale status`.
4. Put TLS in front — **factotum does not do this for you, on purpose**:

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:7777
   ```

   `init` prints this with the port it chose. **If 443 on this machine already serves
   another service, `init` uses 8443 instead** — because `serve --https=443` does not
   fail on a taken port, it *replaces* that handler, and the other service goes dark.
   `doctor` reports that case as `TAKEN` and prints no command.

5. `factotum start`, then open the `https://` URL on your phone.

`factotum doctor` checks steps 3 and 4 agree with each other.

> **The CLI changed shape in Tailscale 1.102.** The older
> `tailscale serve https / <target>` form is gone; `serve` now takes the target
> directly, with the port as a flag. `tailscale serve --help` is authoritative for
> your version.

## Why the bind is loopback

Before this, factotum listened on your tailnet address, and **any peer on the tailnet
could reach it with `curl`**:

```sh
curl -X POST http://100.87.1.2:7777/modules/sessions/sessions
```

The origin check does nothing about that — see below, it defends against a *browser*.
Since factotum launches agents that write to your disk with your privileges, that was
the sharpest edge in the project.

Binding to `127.0.0.1` closes it at the socket: the set of things that can reach the
API is now *processes on this machine*. That is also exactly what the permission hook
needs, which is why it keeps working when `tailscale serve` is down.

## What it will listen on

| Range | What it is |
|---|---|
| `127.0.0.0/8`, `::1` | Loopback — **what `init` now writes** |
| `100.64.0.0/10` | CGNAT — where Tailscale lives |
| `10/8`, `172.16/12`, `192.168/16` | RFC1918, i.e. your LAN |
| `fc00::/7` | Unique local addresses, including Tailscale's IPv6 range |

Loopback is accepted **only when you write it down yourself**, and `init` does exactly
that. It is never landed on by accident: a failed detection that quietly bound to
loopback would leave you with something that starts, looks fine, and is unreachable.

The non-loopback ranges remain legal for an operator who knows why they want one. The
cost is written down below: you lose the local rescue route.

**`0.0.0.0` and `::` are refused, always.** There is no flag.

## Why it checks `Origin`

The bind decides **where factotum can be reached from**. It says nothing about **who
is talking** once inside.

Any page you open in any browser can do this:

```js
fetch('https://your-machine.your-tailnet.ts.net/modules/something', {
  method: 'POST',
  mode: 'no-cors',
})
```

That is a *simple request* — no preflight — so it executes even though the attacking
page cannot read the reply. With no credential in the system, the origin check is the
only thing standing between that page and your daemon.

**The rule is: two exact origins, both declared. Nothing is inferred from an origin's
shape.**

An origin is allowed when it is **string-identical** to one of:

- **`publicOrigin`** from your config — the origin `tailscale serve` fronts;
- **the bind's own origin**, e.g. `http://127.0.0.1:7777`, and **only when the bind is
  loopback**. This is the way back in if `serve` stops, and it is what the permission
  hook talks to;
- anything in **`listen.extraOrigins`**, for a proxy that is not `tailscale serve`.

There is no substring test, no suffix rule, no port arithmetic and no normalisation.

### Why `publicOrigin` is fussy

Because the comparison is exact, a `publicOrigin` that is off by one character means
**403 on everything**, with `doctor` printing two values that look identical. So the
config rejects anything non-canonical: no trailing slash, no upper case, no embedded
credentials, no explicit `:443`, **and no trailing dot**.

The trailing dot is the one that bites. `tailscale status --json` returns the name
fully qualified — `your-machine.your-tailnet.ts.net.` — and your browser sends it
without the dot. `init` strips it; the schema refuses it if it ever gets through.

A non-default port is fine: `https://host.tailnet.ts.net:8443` is canonical and valid,
and `serve --https=8443` works.

### What used to be here

An earlier rule inferred permission from an origin's shape, and a `*.ts.net` suffix
was part of it. That is gone. **The old rule is not restated here** — it is recorded,
with the reasoning and the cost of removing it, in
[ADR-0007](adr/0007-loopback-behind-tls.md). The short version is that the suffix
admitted every name in every tailnet, and the only thing holding it shut was factotum
not being on 443 — which is exactly what changed.

### What the origin check does not do

- **It is not a credential.** It defends against someone else's *browser*. It does
  nothing against a process on this machine with `curl` — which is deliberate, because
  that is what the permission hook is.
- **`Host` is not checked**, so **DNS rebinding is not covered.** Declared, not
  forgotten.
- **There is no rate limit.**

### Tailscale Funnel

`tailscale funnel` publishes the same name **to the whole internet**. The origin policy
does not save you there: it stops a browser, and Funnel exposes the daemon to anything
that can make an HTTP request.

`factotum doctor` warns when Funnel is on for the origin it is serving.

> **`tailscale funnel --https=<port> off` removes your entire serve config**, not just the
> Funnel flag — and not just factotum's handler: **every** serve handler on the machine,
> other services included. Save `tailscale serve status --json` first and re-add each
> handler after, or they are all left without TLS, and nothing says so.

### Running the client with `pnpm dev`

Vite serves the client on `http://localhost:5173` and proxies the API, so the browser
sends **that** origin on every POST — and it is not one of your two. Every write gets
a 403.

The fix, and it is the one place `extraOrigins` is the right answer:

```jsonc
// ~/.factotum/dev/config.json  — DEV ONLY
"listen": { "address": "127.0.0.1", "port": 7778, "extraOrigins": ["http://localhost:5173"] }
```

**Know what that costs.** `http://localhost:5173` is literally "another service on
this machine", which is the thing the policy exists to refuse. It belongs in a dev
config and **never** in `config.template.json` or in prod.

### `dev` has no secure context, and that is deliberate

Your machine has one MagicDNS name, and `serve` fronts one backend — but `dev` and
`prod` are built to run at the same time on different ports. So:

- `init --env dev` writes `publicOrigin` = **the local origin** (`http://127.0.0.1:7778`);
- **no QR is printed for dev**, because that address opens nothing on a phone;
- **`doctor` does not check `serve` in dev**, or it would report a mismatch for ever.

The secure context is for the phone, and the phone talks to prod.

### What the secure context buys, and the one thing that nearly took it away

Over HTTPS the client registers a service worker and Android offers to **install** it:
its own icon, its own window, no address bar. That needs three things, and the third is
the one that cost an afternoon — all of it measured on Chrome 153 / Android:

- **Icons.** With `"icons": []` the install is never offered, service worker or not.
- **A service worker.** It does *not* need a `fetch` handler; `apps/web/public/sw.js`
  has `install` and `activate` and nothing else, on purpose.
- **The manifest served as `application/manifest+json`.** The daemon types static files
  by extension, so the file is `manifest.webmanifest` rather than `manifest.json`. With
  `application/json` everything looks right — secure context, worker registered, icons
  fetched, manifest parsed — and Chrome quietly downgrades the install to a **home
  screen shortcut** that opens in a tab. No 404, no console error, no warning.

## When it refuses to start

Every failure names three things: what it looked for, what it found, and what to do.
`factotum doctor` prints the same picture without starting anything.

**`publicOrigin` — Invalid input / must be a bare canonical origin** — the most likely
failure after upgrading, because **every config written before this change lacks the
field**. Run `factotum init` again, or add it by hand. `doctor` names the field.

**`no interface on this machine has it`** — the address in your config is gone. You
changed tailnets, or reinstalled Tailscale. Run `factotum init` again.

**`listen.interface is "utun4", which has no external address`** — on macOS the
Tailscale interface number **changes across reboots**. Use `listen.address`. On Linux
`tailscale0` is stable and `interface` is fine.

**`is not in a private range`** — you pointed it at a public address.

**`refusing to listen on 0.0.0.0`** — see above.

**`port N is already in use`** — probably the other environment, or something else
entirely. `dev` and `prod` are meant to run at once; the defaults are 7777 and 7778.

**It started, and my phone cannot open it.** Check in this order:

1. `tailscale serve status` — is anything terminating TLS at all?
2. Does its origin match `publicOrigin` exactly? `factotum doctor` compares them.
3. `tailscale status` on both devices — same tailnet, both up?
4. Is the daemon actually up? `curl http://127.0.0.1:7777/health` from this machine.

**Every POST from the client gets 403.** The origin the browser sends is not
string-identical to `publicOrigin`. `doctor` prints both; the error body prints the
origin it received. Look for a trailing slash, a trailing dot, or `:443`.
