# 8. Notifications are the daemon's, and a module gets a narrow slice

**Status:** accepted

## Context

The module contract was written with two things recorded as *known not to fit*:
notifications, and binary request/response bodies. Neither had a consumer, and the rule for
growing the contract is that a field needs one that exists today.

Notifications got one. The permission gate can only ever say *no* (ADR-0006), because
*ask* means freezing a session until a person answers, and there was no way to reach the
person. With TLS in front (ADR-0007) there is a secure context, so Web Push works — and the
first thing that wants it is the gate.

The question was where push lives: inside the sessions package, which is the only consumer,
or in the daemon.

## Decision

**Push belongs to the daemon.** The kernel owns the VAPID key pair, the subscriptions, and
sending. A module receives one new field on `ModuleContext`:

```ts
readonly notify: {
  readonly canReach: () => boolean
  readonly send: (message: NotificationMessage) => Promise<void>
}
```

`FactotumModule` does not change: it is still five fields. `ModuleContext` goes from six to
seven.

## Why the daemon and not the module

- **The keys identify the daemon as a sender.** A module is not a sender, and a
  `ModuleContext` promises a module sees no path outside its own `stateDir` — so a key the
  kernel also reads cannot live under `modules/`.
- **Half of it is not a module's anyway.** The service worker, the browser permission and the
  subscription are the shell's (`apps/web`), not any module's screen.
- **Two modules must not be able to impersonate each other.** The registry binds the module's
  id into every notice, the way it already binds the route prefix and the log prefix. A module
  has no parameter to pass an id in.

## Why this shape

**`canReach` exists so `send` is never called in vain, and it is synchronous on purpose.** The
permission gate asks it before deciding whether it may ask at all, and that decision is pure.
A promise here would push I/O into the one path in the project that must not do any. Without
it, the only way to learn nobody is subscribed would be to send and wait for the failure —
freezing a session for a whole timeout in exactly the case where nobody will answer.

**It is called `notify`, not `push`.** A module does not know the transport. The day there is
another one, the kernel changes and no module does.

**It is narrow, not a general event bus.** A bus would be the right answer for several
consumers with different needs. There is one. The signal to revisit is the **second** consumer.

## What was measured before deciding, and changed the implementation

Against FCM, with a real Chrome 153 and a throwaway profile:

- **Only 404 and 410 mean a device is gone.** A mismatched key pair answers **403** to every
  subscription, and the same subscription answers 201 again with the right pair. A sender that
  treated 403 as "dead" would wipe every phone the first time `keys.json` changed.
- **The limit is 4096 encrypted bytes**, and encryption adds 103, so 3993 in clear. Over it,
  400 — which also says nothing about the device.
- **The `web-push` library's `timeout` is an idle-socket timeout, not a deadline.** Against a
  server trickling a byte a second it was still waiting after ten seconds. So the library only
  encrypts (`generateRequestDetails`) and `fetch` sends with an `AbortSignal`. In shutdown this
  is the only thing between a stuck push service and a daemon that never stops.

## What this costs

**The daemon leaves the private network for the first time.** Until now nothing it did went
past the tailnet. A notice's text travels through the browser vendor's push service. It is
end-to-end encrypted, but the fact, the timing and the size are not — so a notice carries the
least that is enough to decide, never a full path.

**The subscription route has no credential**, like every other route. The origin check stops
someone else's browser; it does not stop a process on this machine, which can register a device
of its own. That is not closed here and cannot be. What is done instead is detection — a new
device is announced to the ones that already existed, the count is capped and visible, and
`factotum push reset` clears it. The reasoning is in the header of
`packages/kernel/src/push/service.ts`.

## What this still does not do

- No retries. A lost notice is lost.
- No general event bus, and no channel other than Web Push.
- No binary bodies: that is still the other thing that does not fit.
