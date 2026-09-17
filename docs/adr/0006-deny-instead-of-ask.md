# 6. The permission gate denies; it never asks

**Status:** accepted — **amended by [ADR-0009](0009-ask-with-push.md) in its part about `ask`.**

> **Amendment, 2026-09-16.** Push exists now (ADR-0008), which is the condition this record
> named for producing `ask`. The gate asks when a device is subscribed and still denies,
> exactly as written below, when none is. What this ADR says about why a blind `ask` is worse
> than a clear refusal stays true, and is why the deny path is kept. It is left as it was
> decided; ADR-0009 says what changed.

## Context

Agents launched by factotum run with `--permission-mode manual` and a `PreToolUse`
hook. The hook's HTTP response **is** the decision — there is no second channel — and
the CLI accepts three: `allow`, `deny`, `ask`.

`ask` means *freeze the session and wait for a human*. The predecessor project
produces it, and it works there because it also has a push notification with buttons,
a waiting state, a timeout that cancels, and a resumption path.

## Decision

**Factotum produces two decisions: `allow` and `deny`.** What would be `ask` somewhere
else is a `deny` **with its reason**, written to the session log and shown on the
screen. The agent is told no, says so in its output, and carries on.

The `Decision` type still has three members, because that is the CLI's contract rather
than this project's. What changes the day push exists is which of them get produced —
not the type, and not the shape of anything around it.

## Why

`ask` is not a decision on its own; it is the first half of a conversation, and the
second half needs a way to reach the owner. Factotum cannot send one:

- without TLS there is no secure context, so no Web Push and no installable PWA;
- `ctx.notify` does not exist, and notifications are one of the things the module
  contract was measured against and found not to fit.

So shipping `ask` would mean shipping a state a session can enter and never leave
except by timing out — which is worse than a clear refusal, not better.

The predecessor also left a measurement that argues the same way from the other side:
**eight of eleven approval requests were agents asking permission to do the work they
had been told to do**, and it wrote the conclusion down — *"an alarm that only sounds
when everything is fine does not get read: it gets silenced."*

## Consequence

**This is not less safe, it is different.** A denied agent does not stop; it
improvises another route. That is why the reason goes to the screen as well as the
log: you find out at the time, not from the diff afterwards.

**And if it is noisy, the site is wrong, not the gate.** An agent that constantly
needs to write outside its site was given a site that does not match its job.

## What this leaves out, on purpose

- No `esperando-aprobación` state, no approval timeout, no resumption path. They would
  all be dead code the moment they were written.
- No "yes, just this once". There is no way to say it.

The measurement that made this comfortable rather than merely necessary came later,
against the real CLI: **a hook reply that carries no decision at all — a 413, a 500,
or a server that is not there — is treated as "not granted" and the tool is blocked.**
So the failure modes around this decision fall closed without anything here having to
arrange it.
