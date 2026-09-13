# Networking, and why there is no password

This is the page to read before running factotum anywhere unusual, and the page to
check when it refuses to start.

## The model, in one paragraph

factotum has **no login, no token and no TLS**. It listens only on a private network
address, and being able to reach that address is the authorisation. On top of that it
checks the `Origin` header, because reaching the address is not the same as being the
client. That is the whole of it.

This is defensible for one person on machines they own. **It stops being defensible
the moment a second person is on your tailnet**, because they can then do everything
you can — launch agents, read your repositories, write to your disk.

## Setting it up

[Install Tailscale](https://tailscale.com/download) on this machine and on your phone,
sign both into the same tailnet, and run `factotum init`. It finds your `100.x`
address and writes it down.

A LAN address (`192.168.x.x`, `10.x.x.x`) works too, but only from that LAN — which
means it stops working when you leave the house, and that is usually the moment you
wanted it.

## What it will listen on

| Range | What it is |
|---|---|
| `100.64.0.0/10` | CGNAT — **this is where Tailscale lives** |
| `10/8`, `172.16/12`, `192.168/16` | RFC1918, i.e. your LAN |
| `fc00::/7` | Unique local addresses, which includes Tailscale's IPv6 range |
| `127.0.0.0/8`, `::1` | Loopback — **only if you write it down yourself** |

The loopback rule matters: factotum accepts `127.0.0.1` if you put it in the config
on purpose, and never lands there by accident. A failed detection that quietly binds
to loopback would leave you with something that starts, looks fine, and cannot be
reached from your phone.

**`0.0.0.0` and `::` are refused, always.** There is no flag. If you genuinely want
factotum exposed, put a reverse proxy in front of it: that is a decision you make
visibly, rather than one of our switches you found.

## Why it checks `Origin`

The bind decides **where you can reach factotum from**. It says nothing about **who
is talking** once inside.

Any page you open in any browser on your tailnet can do this:

```js
fetch('http://100.87.1.2:7777/modules/something', { method: 'POST', mode: 'no-cors' })
```

That is a *simple request* — no preflight — so it executes even though the attacking
page cannot read the reply. With no credential in the system, the origin check is the
only thing standing between that page and your daemon.

**The rule is: same host, same port.** An origin is allowed when its port is the one
factotum listens on and its hostname is one of:

- the address factotum is bound to,
- any `*.ts.net` name (MagicDNS),
- `localhost`, but **only when factotum is actually listening on loopback**,
- anything in `listen.extraOrigins`, for a proxy you put in front.

It is decided by **shape**, not by a list of names, and that is the whole trick: one
host is legitimately reachable by its tailnet IP, its MagicDNS name *and* `localhost`,
and a list built from your config would only ever know one of the three.

Requiring the port is what does the real work. It rejects another machine on your LAN,
it rejects another service on your own machine, and it rejects **Tailscale Funnel** —
which hands out public `*.ts.net` names to anyone with a free account, but serves them
over HTTPS on 443.

### What the origin check does not do

- **It is not a credential.** It defends against someone else's *browser*. It does
  nothing against someone on your network with `curl`.
- **`Host` is not checked**, so **DNS rebinding is not covered**. Closing that would
  mean enumerating every legitimate name for this machine, which is not reliably
  possible — and getting it wrong breaks MagicDNS and `localhost`, which are the two
  normal ways in. We would rather declare the gap than buy it with a daily 403.
- **There is no rate limit.**

### If you put TLS in front

`tailscale serve` can put HTTPS in front of factotum on a `*.ts.net` name without you
managing certificates. That is the likely answer for installable PWAs and push
notifications.

**Read this paragraph before you do it.** Funnel is currently blocked because it
serves on 443 and factotum does not. Once something of yours *is* on 443, that
protection is gone and any `*.ts.net` origin will be accepted. Use
`listen.extraOrigins` with the exact origin you expect and treat the `.ts.net` suffix
rule as needing revisiting.

## When it refuses to start

Every failure names three things: what it looked for, what it found, and what to do.
`factotum doctor` prints the same picture without starting anything.

**`no interface on this machine has it`** — the address in your config is gone. You
changed tailnets, or reinstalled Tailscale. Run `factotum init` again.

**`listen.interface is "utun4", which has no external address`** — on macOS the
Tailscale interface number **changes across reboots**. Use `listen.address` instead;
`init` writes the address for exactly this reason. On Linux `tailscale0` is stable and
`interface` is fine.

**`is not in a private range`** — you pointed it at a public address. That is the one
thing factotum will not do.

**`refusing to listen on 0.0.0.0`** — see above. Use a proxy.

**`port N is already in use`** — probably the other environment. `dev` and `prod` are
meant to run at once, so they need different ports; the defaults are 7777 and 7778.

**It started, but my phone cannot open it.** factotum verified that the address is
real and private on *this* machine. It cannot verify that your phone can reach it —
that is the one thing it has to leave to you. Check that both devices are up in the
same tailnet (`tailscale status`). Inside Docker this is the usual failure: the
container's `172.17.x.x` is a valid private address and completely unreachable from
your phone.
