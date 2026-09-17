# Running agents

Read this before you declare your first site. It says exactly what "the agent may
write here" means, and — at more length — what this does **not** protect you from.

---

## A site is something you write down

```jsonc
// ~/.factotum/<env>/config.json
{
  "modules": {
    "sessions": {
      "enabled": true,
      "sites": [
        { "id": "factotum", "path": "/Users/you/code/factotum" },
        { "id": "notes",    "path": "/Users/you/notes" }
      ],
      "catalog": [
        { "id": "free",    "label": "Free prompt", "invoke": { "kind": "none" } },
        { "id": "review",  "label": "Code review", "invoke": { "kind": "command",  "name": "code-review" } },
        { "id": "planner", "label": "Planner",     "invoke": { "kind": "subagent", "name": "planner" } }
      ]
    }
  }
}
```

Add a site, restart the daemon. No rebuild, no code — and you do not have to edit that
file by hand:

```sh
factotum site add ~/projects/thing      # id derived from the directory name
factotum site add ~/notes --shared      # writable from every site instead
factotum site list                      # or --json, for something reading it
factotum site rm thing
```

It validates the result against the real schema before writing, writes atomically, and
restarts the daemon for you when this environment is installed as a service. **It asks
first**, every time: this is the command that widens what an agent may write, and
`--yes` is how a script says it meant to. Without a terminal and without `--yes` it
writes nothing.

**Nothing is authorised by being inside a folder.** There is no `projectRoots` setting
and no discovery of git repositories underneath something. A site is allowed because
you wrote it down, for the same reason the bind address is: auto-detection lives in
`factotum init` and nowhere else.

Paths must be absolute and must not contain `..`. That is checked when the config is
read. Whether the directory *exists* is checked when the daemon starts, because the
first check cannot touch the disk and the second must not run any earlier.

If a site is wrong, **the module is disabled with the reason** and the rest of factotum
keeps running. `factotum doctor` will tell you which and why.

### Shared paths, and what they cost

A session belongs to **one** site, and a site holds **one** lock — that pairing is what
lets you run an agent per project at the same time, and it is also why several agents
cannot write one shared directory by declaring it in each of them.

For that, declare it once, beside `sites`:

```json
"sharedPaths": ["/Users/you/notes/inbox"]
```

Every session may write there, in addition to its own site. Same rules as a site path:
absolute, no `..`, and it must exist or the module is disabled with the reason. The
denial message then names the whole boundary, site and shared paths together.

**What it is not:** nothing launches into a shared path, and **nothing locks it**. Two
agents writing the same file there at the same time is not prevented by anything —
last write wins, silently. Give agents separate files if you can (one note each, not a
shared index).

The alternative, if that trade is wrong for you, is one site containing everything.
That keeps a single lock over the whole tree, which means one agent at a time. Both
are legitimate; pick the one that matches how you work.

### The catalog

| `kind` | What happens |
|---|---|
| `none` | Your text goes to the agent untouched |
| `command` | `/<name> ` is prepended — **only on the first turn** |
| `subagent` | `--agent <name>`, text untouched |

An entry naming something that cannot be invoked shows up **disabled with its reason**
and the rest of the catalog still works.

The reason `command` only prepends on the first turn is a bug someone else already
paid for: without it, every reply re-invokes the whole skill and treats your answer as
a brand new brief. It also means a follow-up can start with its own `/command` and the
agent will run it with the previous turn's context.

---

## What "may write here" means, precisely

> A **writing** tool whose destination path resolves inside the site's path is
> allowed. Outside, **you are asked** — when a device is subscribed to notifications —
> and refused when nobody can be asked.
>
> **Reading is never asked about**, anywhere. What needs permission is propagating
> outside the site, and reading does not propagate.

**Asking.** A write outside the boundary sends a notification — the site, the tool and the
file name, never the full path — and the agent **waits** on the answer. Allow, and that one
call goes through: an answer covers one call, never the next. Deny, and the agent is told
no with the reason. Nobody answers within an hour, and it is refused the same way, with a
line in the log saying nobody answered. The session stays alive through all of it. See
[ADR-0009](adr/0009-ask-with-push.md).

**Refusing.** With no device subscribed, nothing waits: the call is refused at once, with
the reason in the session log and on the screen, and the agent carries on — which is what
the gate always did ([ADR-0006](adr/0006-deny-instead-of-ask.md)).

**What asking is not.** It is not containment. The `Bash` hole below still lets an agent
write anywhere without asking, and anything on this machine can subscribe a device of its
own. Asking makes an honest out-of-site write something you can approve instead of a blind
refusal; it does not stop a hostile one.

When everything is fine you see nothing. The gate is silent on success on purpose: an
alarm that sounds when nothing is wrong gets silenced rather than read.

---

## The ten things this does NOT guarantee

Every one of these is a real limit, not a caveat.

**1. `Bash` is not checked against the boundary.** `echo x > /somewhere/else` goes
through. Checking a path inside a shell command means parsing shell, and parsing shell
badly is worse than not parsing it at all. This is not theoretical: asked to write a
file, an agent reached for `seq 1 200 > file` rather than the Write tool on the very
first end-to-end run of this feature.

**2. This is not containment.** The agent runs as you, on your filesystem, with your
credentials. The gate is a control, not a sandbox. A tool-permission prefix like
`Bash(git push:*)` is escaped by `cd x && git push`.

**3. There is no isolation between concurrent sessions** beyond one lock per site. Two
sessions in two different sites share everything else.

**4. There is no reversibility beyond git.** There is no worktree per session; what an
agent writes inside a site is reviewed with `git diff` and undone with `git checkout`.
In a site that is not a repository, not even that.

**5. A `Write` bigger than 1 MiB may not reach the gate at all.** The kernel caps
request bodies and answers `413` before the module sees anything, and a `413` carries
no decision. Measured outcome: the CLI treats a reply with no decision as *not
granted*, so the tool is blocked — but that is the CLI's behaviour, not something
factotum arranges.

**6. If you `kill -9` the daemon, its agent keeps running — with no gate.** The
subprocess is detached so that its whole process group can be killed, and that is also
what lets the group outlive its parent. While the daemon is dead the hook is
unreachable, which the CLI treats as *not granted*, so the orphan is effectively inert.
When factotum starts again it **kills that process group first**, then marks the
session failed, then releases the site. Between the two there is nobody, and that
cannot be closed from here.

**7. During shutdown, a hook call gets `503` instead of a decision.** It lasts as long
as stopping takes. What makes it tolerable is that stopping also kills the agent's
process group, so the tool that asked is not going to run either way.

**8. A site deleted after startup is not re-checked.** The boundary is still the path
you declared; a write into a directory that no longer exists is refused by the
filesystem rather than by the gate.

**9. There is no retention.** The log grows and nothing prunes it. It is heavily
redacted — paths, commands and tool names survive, file contents do not — so it grows
slowly, but it grows.

**10. Anyone on your tailnet can launch agents in your sites.** factotum has no
password because it binds to a private address. Before this feature, the worst someone
else on your tailnet could do was read a `ping`. Now they can run code as you. If you
share your tailnet, this is the paragraph that matters.

---

## What it does guarantee

- **The log is the source of truth and it is never rewritten.** Events are appended
  with a contiguous sequence number, written to disk before anything can observe them.
  Close the tab, come back later, and the history is all there.
- **One live session per site**, enforced with an exclusive file creation, so the
  collision is decided by the operating system rather than by a check-then-write.
- **A restart cleans up after a crash.** Sessions left running are marked failed with
  a reason, their sites are released, and any agent that outlived the daemon is killed
  before either of those happens.
- **Cancelling kills the whole process group**, not just the `claude` process. It
  usually has a dozen descendants — MCP servers and their runtimes — and killing only
  the child would leave every one of them running.
- **No flag anywhere skips the permission gate.** There is a `grep` that checks.

---

## When it goes wrong

| What you see | What it means |
|---|---|
| `sessions` disabled in `factotum doctor` | The config fragment or a site path is wrong; the reason is printed |
| `409` when launching | The site already has a live session, or it is a git repo that is dirty or behind. The screen offers to go to the session, cancel it, or launch anyway |
| A session `failed` right after a restart | It was running when the daemon stopped. The log is intact up to the last event that was written |
| A denied write you did not expect | The site is probably narrower than the job. Widen the site rather than widening the gate |
