# 2. No credential; a private bind plus an origin check

**Status:** accepted

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
