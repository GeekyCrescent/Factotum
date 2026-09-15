# 7. Loopback behind `tailscale serve`, and two exact origins

**Status:** accepted

Supersedes part of [ADR-0002](0002-no-credential-private-bind.md): the bind, and the
shape of the origin rule. What ADR-0002 decided about having no credential at all
still stands, and is why this one has to be careful.

## Context

ADR-0002 said when to come back to this:

> The moment a second person is on the tailnet, or the moment TLS sits in front on 443
> — which removes the port check that currently blocks Tailscale Funnel names.

TLS in front is now the documented installation, for a reason that has nothing to do
with security: **the client needs a secure context.** A browser will not install a PWA,
will not register a service worker, and will not deliver Web Push over plain HTTP. On
`http://100.x.y.z:7777` the client is a web page you have to find again every time.

So the trigger arrived deliberately rather than by accident, and both halves of
ADR-0002's network decision had to be re-examined at once.

## Decision

**The daemon listens on loopback, and `tailscale serve` terminates TLS in front of it
on a `*.ts.net` name. The origin policy compares two exact declared origins, and
decides nothing by shape.**

- `publicOrigin` — declared in the config, required, validated canonical.
- the bind's own origin — composed, and **only when the bind is loopback**.
- `listen.extraOrigins` — unchanged, still the operator's hatch.

`factotum` requires Tailscale now. That is a real increase in what the project demands
of you, and it is the price of the client being an app.

## Why the suffix rule was deleted rather than redesigned

The old policy accepted any `hostname.endsWith('.ts.net')`, on the reasoning that a
host is legitimately reachable by three names — its tailnet IP, its MagicDNS name, and
`localhost` — so a list built from the config would answer 403 to two of them.

That reasoning was sound and it stopped applying. **With a proxy in front there is
exactly one name the client can have been loaded from, and it is the one the
certificate covers.** A list is no longer a partial answer; it is the whole answer.

The suffix rule also has to be understood for what it actually was. It was never a
defence: it admitted **any** name in **any** tailnet, including every name Tailscale
Funnel hands out to anyone with a free account. The only thing holding it shut was the
port comparison — Funnel serves on 443 and factotum did not. Putting TLS on 443 is
precisely what removes that lock. Keeping the rule and adding a condition would have
meant carrying a rule whose failure mode is "any stranger's browser", to solve a
problem that no longer exists.

## Why the bind moved, which is the larger change

Before this, any peer on the tailnet could reach the daemon directly:

    curl -X POST http://100.x.y.z:7777/modules/sessions/sessions

The origin check does nothing about that. It defends against **someone else's
browser** — a page you open that quietly POSTs to your daemon — and not against
someone with a shell. Since factotum can launch agents that write to your
repositories, "anyone else on your tailnet has everything you have" was the sharpest
sentence in the README.

Binding to loopback closes it at the socket. The set of things that can reach the API
becomes *processes on this machine*, which is a much smaller and more honest set — and
it is the same property the permission hook already depends on.

## The two things this got wrong on the way, both worth keeping written down

**A trailing dot is invisible and fatal.** `tailscale status --json` returns
`Self.DNSName` fully qualified — measured, `juans-macbook-pro.tailbd0167.ts.net.` —
and a browser sends the name without the dot. The comparison is exact, so composing
`publicOrigin` from that value unchanged means 403 on every request, with `doctor`
printing two values that look identical. The guard on the config field is therefore
double: canonical **and** no trailing dot, because `new URL('https://x.ts.net.').origin`
is byte-identical to its input and the obvious check passes it.

**The same class of bug appears in the serve status.** The JSON key is
`"host.tailnet.ts.net:443"`, with the port always explicit, while a canonical origin
omits `:443` — so `doctor` comparing them naively reports a mismatch on every correctly
configured machine, for ever.

Both are the same failure: **two strings that look the same and are not.** It is the
characteristic risk of a policy built on exact equality, and the price of exact
equality being otherwise unambiguous.

## What this costs

**The tests stopped being regression tests.** With a policy decided by shape, each
negative case in `net/origin.test.ts` was refused by a *different* rule, so breaking
one rule broke one test. With exact equality they are all refused by string
inequality: they pass or fail together, and none can regress alone. They are kept as
documentation of what the file was built against, and the header says so. What defends
the file now is one test that distinguishes raw equality from `new URL(x).origin`, and
a grep that bans substring operators.

**`dev` has no secure context.** A machine has one MagicDNS name and `serve` fronts one
backend, while dev and prod are built to run side by side. So dev's `publicOrigin` is
its own loopback origin, dev prints no QR, and `doctor` does not check serve there.

**factotum cannot tell you the proxy is down.** It does not manage `tailscale serve`,
start it, or require it. `doctor` reports on it; the daemon starts either way, and the
loopback origin stays accepted so there is a way back in from this machine.

## What this still does not do

Unchanged from ADR-0002, and still true: `Host` is not checked, so DNS rebinding is not
covered. There is no rate limit. And **there is still no credential** — this ADR moves
where the daemon listens and tightens what it accepts, but a process on your machine
can still talk to it, which is exactly what the permission hook is.
