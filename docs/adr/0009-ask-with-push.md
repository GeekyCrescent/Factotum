# 9. The gate asks the owner — and says plainly what asking is not

**Status:** accepted. Amends the `ask` part of [ADR-0006](0006-deny-instead-of-ask.md).

## Context

ADR-0006 refused to produce `ask` because an ask nobody can see is a state a session only
leaves by timing out. It named the condition for changing that: a way to reach the owner.
ADR-0008 built it — Web Push from the daemon.

## Decision

**A write outside the boundary asks the owner when a device is subscribed, and is denied when
none is.** The CLI's hook reply is held while the owner decides; the session stays `running`
throughout, because it is — its process is alive, blocked on the reply.

- **`decide` stays pure.** It receives `canAsk` as a boolean the engine resolved beforehand
  (`notify.canReach()`, synchronous by contract). The wait lives in the engine, never in the
  function that decides.
- **Ask and deny carry the same reason**, so an ask nobody answers reads exactly like the deny
  the gate gave before.
- **The reply to the CLI is only ever allow or deny.** `ask` is the engine's word, not the CLI's.
- **An allow covers one call.** There is no "always".
- **Nobody subscribed means deny at once.** Nothing waits for a person who cannot be reached.

## The window: an hour

The CLI waits for a hook reply as long as its `timeout` says, and that is the window a person
has to answer from their pocket. **An hour** — the owner's choice, and the predecessor's default.

Measured before choosing, against the real CLI (Claude Code 2.1.272):

- the reply was held **700 s** under `timeout: 3600` and the tool ran when it came;
- when a hook's timeout expires, the CLI **blocks the tool and the session carries on** — the
  agent is told a generic "you haven't granted it yet" and says so;
- a Node server with its default timeouts held the response the whole time;
- the `tool_use` event reaches the stream **before** the hook is even called, so the screen can
  show a call waiting for its result with no new kind of event.

factotum gives up **thirty seconds before** the CLI does, so the log can say *nobody answered*
instead of inheriting the CLI's generic text.

The cost, written: an ask nobody sees freezes that agent for up to an hour. In the predecessor,
eight of eleven approval requests were agents asking to do what they had been told to do — so
a site that fits the job is still the first answer to a noisy gate.

## The token

An ask is answered with `POST /modules/sessions/asks/<token>/answer`. **The token is the only
authorisation**, because the origin check does not stop a process on this machine (ADR-0007),
and the gated agent is one. So the token:

- is 32 random bytes, not a time-ordered id;
- **never touches disk.** The gate lets an agent read any file, so a token in the session log or
  in `meta.json` would be a token handed to it. It lives in memory and in the encrypted push;
- is listed by no route and written to no log.

It reaches the owner's phone in the notice, and the notice opens the session **with the token in
the URL**, so the owner can answer from the screen even where notifications have no buttons. The
screen reads it once and removes it from the address bar.

## What asking is not

**Asking is not containment, and pretending otherwise would be worse than not asking.**

- **The `Bash` hole is still open.** An agent that wants to write outside its site does not need
  to ask: `echo x > /outside` goes through, as documented in `docs/running-agents.md`.
- **Anything on this machine can subscribe a device of its own** — the subscription route has no
  credential, like every route — and have the next ask delivered to it, token included. That is
  detected, not prevented: a new device is announced to the ones already subscribed, the list is
  capped, and `factotum push reset` clears it (ADR-0008).
- **`0600` on the key files does not stop a local reader**, because the agent runs as the owner.

So this is a boundary of hygiene. What `ask` buys is that an honest write outside the site — the
common case, an agent doing its job — becomes something the owner can approve, instead of a blind
refusal the agent improvises around. Containing a hostile agent is still the job of real isolation
(a container, `sandbox-exec`), and factotum still does not have it.

Amended by ADR-0010: the token is now kept on the subscribed device while pending.
