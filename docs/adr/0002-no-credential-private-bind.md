# 2. No credential; a private bind plus an origin check

**Status:** accepted — **partly superseded by [ADR-0007](0007-loopback-behind-tls.md)**

> **What is superseded: the bind, and the shape of the origin rule.** The daemon now
> listens on loopback behind `tailscale serve`, and the origin check compares two
> declared origins rather than deciding by shape. ADR-0007 has the reasoning and the
> replacement; it is not repeated here.
>
> **What still stands, and is the reason this decision was made:** no credential, and
> reachability as the authorisation. The four properties under *What makes it
> defensible* still hold — the address is declared, ranges are validated, every
> spelling of a wide bind is refused, and the socket is asked what it actually bound
> to. The loopback bind makes them stricter, not obsolete.
>
> This document is **not** rewritten. It records what was decided in its own time, and
> *When to revisit* below named the trigger correctly before it happened.

## Context

factotum can launch agents that write to your repositories with your privileges. The
question is how it decides that a request is yours.

## Decision

**No login, no token, no TLS.** It listens only on a private address — Tailscale, or
a LAN — and being able to reach it is the authorisation. On top of that, it checks
`Origin`.

The owner made this call explicitly. A shared token was proposed and declined.

## What makes it defensible

A network-layer decision is only as good as the bind, so the bind is not left to
chance:

- the address is **declared in the config**, never guessed at startup;
- it is **validated against ranges**, so a public address cannot be used by mistake;
- `0.0.0.0` and every spelling of it are **refused unconditionally** — no flag;
- after `listen`, the socket is **asked what it actually bound to** and the process
  closes if that disagrees. Intent is validated twice and outcome once.

And because the bind says nothing about who is talking once inside, `Origin` is
checked on the same-host-same-port rule (see `docs/networking.md`). Without a
credential, that is the only defence against a page you happen to open.

## What this accepts

Anyone else on your tailnet has everything you have. DNS rebinding is not covered.
There is no rate limit. All three are written down in the README rather than hidden.

## When to revisit

The moment a second person is on the tailnet, or the moment TLS sits in front on 443
— which removes the port check that currently blocks Tailscale Funnel names.
