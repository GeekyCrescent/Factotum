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

## Moving sessions: «Me voy» and «Volví»

From the drawer, the **…** beside a host's heading offers **Move my sessions to <other host>**. A sheet
shows first what would go and what would not, and why; nothing moves until you confirm. Why it is
built this way is [ADR-0020](adr/0020-session-handoff-between-hosts.md).

### What is portable

A project moves when it is **a git repo with an `origin`, cloned on both hosts**. The two are paired
by their remote, not by their name or path (the vault can be `personal` on the Mac and `obsidian` on
the Linux box). A project that only one host has, or that is not a repo, stays where it is — and is
still launched there from either app.

**Git needs read access to each remote, without asking anything**: the pull before a launch and the
handoff's `fetch` only read. Nothing of a handoff writes to the remote. `factotum doctor` says, per
project, «reads origin without asking» or what failed.

### What goes, and what does not

- **Goes:** every conversation not archived, touched in the last 24 hours and not running — its log,
  its meta, the attachments you sent in it, and the CLI's transcript with its folder, so it carries on
  where it was. And its project's code: the commits of the branch the remote does not have and the
  uncommitted work, **in a `git bundle` from one daemon to the other, never through the remote**. On
  the other host the same branch is at the same commit, and your work is there as uncommitted changes.
- **Does not go:** a running conversation (and then nothing of its project), background services
  (stopped here first, and named in the report), anything git ignores, the CLI's per-project memory.
- **One owner at a time.** On the host it left, a conversation says «Moved to <host>» and takes no
  reply. Coming back, the copy that went on replaces it, with one line in the log per crossing.
- **New files nobody ignored go too**, like a `.env`: the preview lists them by name before you
  confirm. They go to your other machine only.

### When a project stays

The preview and the report say why, in plain words. The ones worth knowing:

- **«<host> has commits on <branch> that this host doesn't»** (`target-ahead`): something — often the
  Obsidian Git plugin — pushed from the other side. Pull them here first, then move.
- **«That project has uncommitted changes on <host>»** (`target-dirty`): the other side must be clean,
  and must stay clean until the move ends.
- **One conversation that cannot go holds its whole project back**: a project's code travels whole, so
  no conversation is left behind on a tree that was cleaned.

### Ignore rules outside the repo must match

`.gitignore` travels with the code. **`core.excludesFile` (usually `~/.config/git/ignore`) and
`.git/info/exclude` do not** — they are each machine's. When they differ:

- towards the host that ignores a file the other does not, the move stops with **«<host> ignores these
  files and has its own copy»** (`target-ignored-collision`), and nothing is touched;
- the other way, the file shows up as a change there, the tree is never clean, and every move is
  `target-dirty` — for ever.

The real cases on these machines: the Mac ignores `**/.claude/settings.local.json` in
`~/.config/git/ignore`, and the vault has `.obsidian/plugins/obsidian-git/obsidian_askpass.sh` in its
`.git/info/exclude`. **The remedy:** put the rules a project needs in its own `.gitignore`; or copy the
same lines into the same files on both hosts. `factotum doctor` compares them per project with the
other host («ignore rules match omarchy», or which file differs), and the preview warns.

### If the other host never answers

If the other host stops answering after the commit was sent, the project waits as **«Waiting for
<host>»**, still locked here: it may or may not have been installed there. When the host comes back,
the daemon asks and finishes on its own. If it never comes back, **Keep them here** in the report
unlocks it — and if the other host did install them, the two copies now go on apart.

### `ABORT-FAILED` in `doctor`

If the other host could not undo a failed move completely, its journal says `abort-failed`, and
`factotum doctor` **on that host** shows its id, the project, the steps left, and its folder
(`~/.factotum/<env>/modules/sessions/handoff/<hid>/<project>/`). What each step means:

- `restoreSession`: a conversation that was replaced is in `replaced/<id>/` of that folder. Move it
  back to `~/.factotum/<env>/modules/sessions/sessions/<id>/` (replacing what is there).
- `restoreTranscript`: a transcript is in `replaced/cli/<folder>/`. Move `<id>.jsonl` and `<id>/` back
  to `~/.claude/projects/<folder>/`.
- `discardImported`, `removeTranscript`, `removeUpload`: what arrived is still installed; delete it.
- `restoreTarget`: the repo is not back where it was. If you edited it meanwhile, your changes are in
  `refs/factotum/handoff-rescue/<hid>` (`git show` it); then put the branch back with `git checkout`.

When it is all back, delete that folder and its journal (`…/handoff/<hid>/<project>.json`). Nothing of
an `abort-failed` is ever pruned on its own.

### What is kept, and for how long

The source keeps the uncommitted work it sent in `refs/factotum/handoff-backup/<hid>`, and the target
keeps anything it had to rescue in `refs/factotum/handoff-rescue/<hid>`, for 14 days. Each daemon
prunes its own leftovers at start and once a day.

## What it does not do

- **More than two hosts.** `peers` takes one.
- **Discovery.** A peer is whatever the config says, and nothing else.
- **Moving on its own** when the lid closes or the network drops: it is a button.
