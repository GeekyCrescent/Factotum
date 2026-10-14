# 20. Moving sessions between hosts: the code in a `git bundle`, a journal per project, one owner at a time

**Status:** accepted

## Context

Factotum runs on two machines (ADR-0019): a Mac that sleeps and a Linux box that does not. When the
owner leaves, the Mac sleeps and its conversations stay on its disk. «Me voy» moves every recent,
idle conversation to the other host, with the code they were working on; «Volví» brings them back.

What travels for each conversation is its log and meta, the attachments its owner sent, and the
Claude CLI's transcript with its folder — `--resume` finds a conversation by id, but only if the file
is there (measured: the CLI names its folder after the real path, every character outside
`[A-Za-z0-9]` a dash, on both machines). What travels for each project is its code: the branch's
commits the remote does not have, and the uncommitted work.

## Decision

### The code travels in a `git bundle`, daemon to daemon, never through the remote

The source makes a **WIP commit** of the working tree on a temporary index (`GIT_INDEX_FILE`,
`read-tree HEAD`, `add -A`, `write-tree`, `commit-tree`): the owner's index and `HEAD` are never
touched, what git ignores never enters, and the commit's identity and signing never depend on the
host. Then a `git bundle` of the local commits the remote lacks plus the WIP, through two temporary
refs that live only for the command (`bundle create` needs refs; with everything covered it refuses,
so the commits are counted first). It is sent as one more file of the manifest, through `ctx.peers`.

**Nothing is pushed.** The first design pushed a temporary branch to the remote, and it worked on all
three remotes (measured). The owner decided against it: on the work's server, colleagues would see the
branch, the server would log the activity, and half-done work and untracked files nobody ignored would
sit there. The bundle keeps all of it between the owner's two machines. The remote is only **read**: the
source fetches before bundling, and the target fetches once if it lacks a base (`ensureBase`), or,
when there is no bundle, the source's `HEAD`.

On the target the branch is checked out (or created at the source's `HEAD`) and fast-forwarded,
always with `--no-overwrite-ignore`, and the WIP is applied with plumbing: `read-tree -m -u HEAD
<wip>`, a refreshed `diff-files --quiet` to check the tree is the WIP, then `reset -q` so it lands as
uncommitted changes. `color.ui`, `diff.noprefix` or `core.autocrlf` cannot break it. A target whose
branch has commits the source lacks is `target-ahead`: nothing is merged or reordered — pull them to
the source first.

### Each host's ignore rules: warn, and never overwrite

`read-tree -m -u` overwrites, without a word, an untracked file the target ignores; and turns a folder
that holds only ignored files into the WIP's file (both measured). Inside the repo it cannot happen —
`.gitignore` travels with the code — but `core.excludesFile` and `.git/info/exclude` are each host's.
So before touching anything the commit runs **`ignoredCollisions`**: every path the handoff adds that
exists on disk in any form, and every folder on its way that is not a folder, is asked to `status
--ignored`; any hit is `target-ignored-collision`, with the paths for the owner (never for the log).
The rules themselves are **a requirement of the host**, documented (`docs/hosts.md`), compared by the
preview (`ignore-rules-differ`, a warning) and by `doctor`. Blocking every project whose digests
differ was rejected: most differences touch no file of that repo, and what does break is already
stopped by the collision check and by `target-dirty`.

### Git runs without hooks, and by the environment

Every git command of the handoff, on both sides, gets `core.hooksPath=/dev/null`,
`maintenance.auto=false`, `gc.auto=0`, `commit.gpgSign=false`, `core.fsmonitor=false` and
`submodule.recurse=false`, and the bundle is fetched with `fsckObjects`. They go in
`GIT_CONFIG_COUNT`/`KEY`/`VALUE`, never as `-c`: `runGit` tells a network command by `args[0]`, and
with `-c` first a `fetch` would stop reading the repo's `core.sshCommand`. One timeout table, 60 s by
default — a command missing from it must not fall to the 5 s the vault does not fit in.

### One owner at a time, and a lock that blocks every mode

A handoff takes the project's lock as `handoff-<hid>` on both hosts. Like `removing`, it blocks every
mode — a `concurrent` project's shared sessions included — and a launch, a reply or a delete is told
«this project is being moved to another host», never `busy`. The handoff's steps run in **a queue of
their own** per project (`KeyedQueue`), not the locks' queue: a step inside that queue that released
the same site would wait behind itself.

On the source, a moved conversation keeps its log and gets `movedTo`: it is read-only («Moved to
omarchy · Open»), and a reply is a 409. On the way back, the copy that extends it replaces it. **The
target writes the handoff event, one per crossing**, so the source's log is an exact prefix of what
returns — and the target checks that on the bytes before it replaces a copy.

### The journal: before the lock, and before every step

Each project has its journal on each host, `handoff/<hid>/<siteId>.json`, written atomically by its
queue only. **It is written before the lock is taken and before it is let go**, so a `handoff-*` holder
always has a journal that explains it; and inside `installing` **every intention is written before its
step** — `branchCreated` before `checkout -b`, each `installed` and `replaced` before its rename — so
a restart halfway knows exactly what to undo, and the undo tolerates an intention that never happened.

What a restart does is in three moments, because `start()` has 10 s: inside it only journals and
holders (no git, no peer); then, on a timer, what needs git; then, on an interval while the peer is
reachable, what needs it.

### Why the source does not abort after the commit, and «Keep them here»

Until `committing` is written, any failure aborts **on the source**, without waiting for the peer: the
target cannot have installed anything, and its TTL lets its side go. After it, the commit may have
gone, and aborting on a guess could leave the conversations on both hosts or on neither. So the source
asks `status` until it knows. If it never knows — the peer gone for good — the project stays
`pending-peer`, with its lock, until the owner says **«Keep them here»**: the sessions stay without
`movedTo`, the tree is not touched, and the sheet says the risk first (if the other host did install
them, the two copies now go on apart).

A 404 from the peer is never read as «aborted» (it may have pruned a `committed`), except a 404 to the
commit itself, which found no journal and installed nothing. `done` is a notice, sent once and never
retried: after `committed` neither side waits for the other, and what the target keeps is the prune's.

### `abort-failed` is not `aborted`

If a step of the target's undo fails, the others are still tried, and the journal says `abort-failed`
with what is left — never `aborted`, which promises everything is as it was, and which the prune trusts
to empty `replaced/`, where the owner's only copy may be. The lock is let go anyway (a lock nobody can
release would close the project for ever); nothing of it is pruned; `doctor` shows it, and
`docs/hosts.md` says what to do with each step.

### The peer's routes are not a credential

They have shape: a `hid` that must be a UUIDv7 near this host's clock, a `siteId` of this host, a
`prepare` that must name this host's remote, a manifest with a closed list of kinds, one fixed `rel`
per kind inside `staging/<sessionId>/`, only for sessions `prepare` checked, with caps (200 sessions,
1 MiB per meta, 4 GiB per project, free disk). The target does not replace a conversation it still
owns, one running, or one of another project; it receives one handoff at a time; and a project it
prepared lets go an hour after `prepare` whatever keeps arriving. That is a limit on what the owner's
other machine can do by mistake, not authentication: whoever is on the tailnet can already launch
agents (ADR-0002).

## Consequences

- **The trade is privacy for a dependency on the other host.** Nothing of the work reaches GitHub or
  the work's server; in exchange, the code arrives only if the target can reach the source.
- **The peer can write any content into the working tree** — that is what moving uncommitted work is.
  A file the source has and the target runs (a `package.json` script, an `.envrc`) arrives with it.
  Filters named by a `.gitattributes` of the peer's commits run as the owner configured them; they are
  not neutralised, because that would break a repo of the owner that uses LFS.
- **Attachments arrive without an owner on the target**: the log names them under the source's root,
  so deleting the conversation there does not delete them. Accepted rather than tracked.
- **A conversation older than a day, archived, or running does not move**, and its project may be
  held back by one that cannot: a project's code travels whole.
- **The prune ages everything by this host's clock** — a journal's `createdAt`, a ref's commit date —
  not by the `hid`, which on the target the peer chose.

## What this does not do

- Move a running session, or one with a pending `ask`.
- Move background services: they are stopped on the source before the WIP, and the report names them.
- Move the CLI's per-project memory, or anything git ignores.
- Rewrite paths inside a transcript or a log: the history says where each thing was done.
- Hand off automatically when the lid closes.
