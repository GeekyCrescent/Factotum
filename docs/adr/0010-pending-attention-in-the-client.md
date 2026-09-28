# 10. What is pending lives in the client — and that amends ADR-0009

**Status:** accepted. Amends the token rules of [ADR-0009](0009-ask-with-push.md).

## Context

An ask reaches the owner as a notification, and until now the notification was the only way to
it. Dismiss it, or miss it among others, and the agent waits for an hour with nothing on screen
saying so. The client needs to count what is waiting, list it, and open it without the
notification. For an ask that means keeping, on the device, the one thing that answers it: the
token.

## Decision

**The service worker keeps each notice that asks for something until a deadline, and the app
reads it from there.** A notice carries its deadline in a typed field; the worker stores it in
IndexedDB when it arrives; the shell counts what is still alive and hands each module its own;
the module shows it, answers it, and says when it is over.

### 1. The amendment

ADR-0009 says the token "never touches disk". From here on that is true of the **daemon** and
no longer of the **subscribed device**: the worker writes the notice's `data`, token included, to
the device's IndexedDB, and it stays there **only while the ask is pending**. The daemon still
writes it nowhere, and no route lists it.

### 2. The rules for the token on the device

- It is **deleted** when the ask is answered here, when its deadline passes, when reading it
  answers 409 or 404, and when its session is seen no longer running.
- The stored `path` has **no query**: navigating from a pending never puts a token in the URL.
- **The query is one-use.** A notification still opens `/m/<id>/<rest>?ask=<token>`; the shell
  takes the whole query out of the address bar **before the first render** and hands it to the
  screen once. A screen that pushes a history entry later copies a URL that is already clean.
- The files that handle pendings, asks or the query **do not call `console` at all**, so no log
  line can carry one.

### 3. The daemon's own machine

The case that makes this dangerous is a browser on the machine the daemon runs on: its profile
is on disk, and the agent can read files. So the kernel tells the client, when it subscribes,
whether it is that machine, and **a browser there keeps no token**:

- a page loaded from the loopback origin (`http://127.0.0.1:7877`) can only be this machine;
- through `tailscale serve`, the source IP serve forwards is compared with this machine's
  addresses. Measured: serve **overwrites** `x-forwarded-for` and adds `tailscale-headers-info`,
  so the IP is believed only with that header. A request straight to the loopback bind can carry
  anything, and its IP is not believed;
- anything else is "not this machine". Missing data never takes the token away from the phone;
- until the daemon has said, the worker treats the device as this machine: the safe side.

**What the detection does not close**, measured with a real Chrome profile: Chrome itself keeps
the token on disk while the notification exists, in its notification store, and after the page
is opened, in its session-restore data and its metrics. Answering does not clean any of it. The
HTTP cache kept the page too, with the token in its key, until everything outside `assets/` was
served `no-store` (this spec). A token that travels in the notification's URL reaches those
places whatever the client does; moving it out of the URL is left for a later spec.

**And the proportion.** ADR-0008 already accepts that anything on this machine can subscribe a
device of its own and receive **every** ask from then on; it answers that with detection (the
announcement, the cap, `factotum push reset`). A token kept in a browser on this machine exposes
**less**: only the asks that reached that browser, and only while they wait. The detection here
is defence in depth over a smaller risk than one already accepted. `doctor` and the Device page
say which subscriptions are this machine, and **always** warn, once there are any, that a browser
here should not subscribe.

### 4. The `until` field

`NotificationMessage` gains `until?: string` (ISO 8601): *this notice asks for something until
then*. It is typed, not hidden in `data`, because the worker interprets it. Its only consumer is
the worker, which keeps a notice with a future `until` as pending. The kernel does not read it.

### 5. The client contract grows — in `apps/web`, not in `core`

`ModuleViewProps` gains `navigate`, `openDrawer`, `overlay`/`setOverlay`, `pending`,
`pendingTotal` and `resolvePending`, and `rest` now follows the URL. `ModuleClient` gains an
optional `Drawer` (what the module adds to the shell's drawer) and `ownsTopBar` (the module draws
its own bar; otherwise the shell draws a fallback bar, so no screen is left without a drawer). A
module meets it **structurally**, declaring the props it uses, and imports nothing from
`apps/web`: a module that declares fewer still fits, which is why `modules/example` did not
change. See [writing a module](../writing-a-module.md).

### 6. Why there is no route that lists asks

`GET /modules/sessions/asks/:askId` reads **one** ask, by its token, with `cache-control:
no-store`: whoever can read it could already answer it. A route that listed pending asks would
hand every token to anything that can reach the API, and on this machine that includes the
agent. The list of what is pending is the device's own, built from what reached it.

## Consequences

- The owner can answer an ask from the drawer after the notification is gone. That is the case
  that used to leave an agent frozen for an hour.
- A device that is lost while an ask is pending holds that token until the deadline, one hour at
  most, exactly as its notification already did.
- The detection of this machine is for browsers, not for the agent, which ADR-0008 already
  treats as able to subscribe.
