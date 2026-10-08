# Two hosts, one app

factotum can drive two machines from one app on your phone — say, a Mac that sleeps and a Linux
box that is always on. Each machine keeps its own daemon, its own projects and its own catalog.
The phone talks to one of them, and that one reaches the other.

This page is how to set it up. What it changes in the security model is in
[networking.md](networking.md#two-hosts-the-proxy-and-the-relay), and why it is built this way is
[ADR-0019](adr/0019-peers-and-the-proxy.md).

**Before you start**, each machine must already work on its own: `init`, `tailscale serve`, a
daemon kept up, `doctor` clean — the [README](../README.md) on each. Both in the same tailnet.

> **`factotum` is probably not on your `PATH`.** Run it from the repository as
> `node packages/cli/dist/main.js <command>`. Every `factotum …` below means that.

## Choose the host the phone talks to

**The one that is always on.** The app is installed from it, and it is the one subscribed to
notifications. If it is asleep, the app does not open at all; if the *other* one is asleep, the
app opens and shows it as unreachable. Below, that host is the Linux box and the other is the Mac.

## 1. Tailscale DNS, on both

```sh
tailscale set --accept-dns=true
```

On **both** machines. Without it, a machine does not resolve the other's `*.ts.net` name, and the
peer looks down for no reason you can see. Measured on a Mac where it was off: `curl` failed to
resolve the name, and so would the daemon. `tailscale dns status` says whether it is on.

## 2. `peers` in each config

Each host names the **other** one, by its `publicOrigin` — copied exactly as the other host's
config has it, port included. One peer, at most.

```jsonc
// ~/.factotum/prod/config.json on the Linux box
"peers": [{ "origin": "https://your-mac.your-tailnet.ts.net:8443" }]

// ~/.factotum/prod/config.json on the Mac
"peers": [{ "origin": "https://your-linux.your-tailnet.ts.net" }]
```

The same rule as `publicOrigin`: canonical, no trailing slash, no trailing dot, no `:443`. A peer
that is this host's own origin, or shares this host's machine name, stops the daemon from starting
with `peer-invalid` and says which.

Restart both daemons. On the Mac, `factotum install --env prod` replaces the running one; on Linux,
`systemctl --user restart factotum`.

Then, on each:

```sh
factotum doctor
```

Each lists its peer: its name, whether its `/health` answers, its version and how many devices it
has subscribed. If it prints `CANNOT RESOLVE`, go back to step 1.

## 3. The app, from the always-on host

On the phone, open the Linux box's `https://` address, **install** the app and turn notifications
on. That is the only app you need.

## 4. Remove the other one

If the phone already had the Mac's app installed:

1. Uninstall the Mac's app from the phone.
2. **Stop the Mac's daemon** — `factotum uninstall --env prod`. `push reset` refuses while it runs,
   because the daemon holds the device list in memory and would write it back.
3. `factotum push reset --env prod` on the Mac. It forgets every device subscribed there.
4. Start it again: `factotum install --env prod`.

Skip this and every notice from the Mac arrives **twice**: once to the device still subscribed to
it, and once relayed through the Linux box.

## What you get

- **The drawer has a heading per host.** A host that is down is folded and grey, with when it was
  last seen, and nothing waits on it.
- **Each host shows all of its projects**, git or not. A project that exists only on the Mac is
  launched on the Mac, from the app the Linux box serves.
- **A launch runs on one host, with that host's things**: its projects, its catalog, its
  attachments. *Run on* switches host; it offers only hosts that answer, and the app remembers the
  last one you chose on this device.
- **A session says which host it is on**, and its `ask`s, questions and approvals are answered from
  the app — from the session, from the strip of pendings and from a notification. A notice from the
  Mac is titled with the Mac's name.
- **A git project that is behind its remote is fast-forwarded before the agent starts**, when its
  tree is clean and no other session is working in it. Never forced: a dirty tree or a divergence is
  the same freshness warning as before.
- **The Mac asleep is a normal state.** Its sessions are unreachable until it wakes; nothing else
  stops. A launch on the Mac that times out says it **may** have started, and is not retried.

## What it does not do yet

- **A session does not move between hosts.** It stays on the host that launched it. To carry on
  elsewhere, start a new session there; the code gets there however it gets there today, by git.
- **More than two hosts.** `peers` takes one.
- **Discovery.** A peer is whatever the config says, and nothing else.
