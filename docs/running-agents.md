# Running agents

Read this before you add your first project. It says exactly what "the agent may
write here" means, and — at more length — what this does **not** protect you from.

---

## A project is something you approve

A project (a *site*, in the code) is a folder an agent may write in. They live in
`~/.factotum/<env>/modules/sessions/projects.json`, and **the daemon is the only thing
that writes that file** ([ADR-0011](adr/0011-projects-registry-and-grants.md)).

**From the app:** Projects, *Add project*, type the folder (`~/code/thing` works). The
daemon checks it and sends an approval to your phone; nothing is added until you answer
there. What gets registered is the folder's **resolved** path, and its id comes from the
resolved folder's name unless you type one. Name and colour you can change any time,
with no approval; deleting a project deletes its conversations and never its folder.

The first start seeds the file from the config's `sites` and `sharedPaths`, as they are.
After that the config's lists are not read, and the start says so.

**Without a phone:** stop the daemon (`factotum uninstall --env <env>`, or stop
`factotum start`), add an entry to `projects.json`, and start it again (`factotum install`
rewrites the LaunchAgent with the PATH of the shell you run it from, so run it where
`claude` is on the PATH). An edit made while the daemon runs is ignored and overwritten
by its next write. `factotum site add` prints this recipe, with the real path of the file
and an example entry; it no longer writes anything.

```json
{ "version": 1,
  "projects": [{ "id": "thing", "path": "/Users/you/code/thing" }],
  "shared": [{ "path": "/Users/you/notes/inbox" }] }
```

```sh
factotum site list          # what the daemon has, or --json for something reading it
factotum doctor             # where the file is, how many projects, whether it is broken
```

**Nothing is authorised by being inside a folder.** There is no `projectRoots` setting
and no discovery of git repositories underneath something. A project is allowed because
you approved it.

A project may not be `/`, your home, `~/.factotum` or the checkout factotum runs from
(nor anything inside or above those two), and may not equal, contain or sit inside
another project, even one whose folder is missing today.

**A project whose folder is missing fails alone.** It launches nothing and its
conversations are not read until the folder is back; every other project carries on. A
session already running there keeps the boundary it started with.

If `projects.json` does not parse, the module runs with **no project**, says why in
Projects and in `factotum doctor`, and never writes over the file. A single bad entry is
skipped, said, and kept in the file as it was.

### Shared folders, and what they cost

A session belongs to **one** project, and a project holds **one** lock: that pairing is
what lets you run an agent per project at the same time, and it is also why several
agents cannot write one shared directory by declaring it in each of them.

For that, share it once, from Projects (*Shared folders*), with the same approval on the
phone. Every session may then write there, in addition to its own project. Shared
folders change only while **no session is running**, so no live session's boundary moves
under it. A shared folder may sit inside a project.

**What it is not:** nothing launches into a shared folder, and **nothing locks it**. Two
agents writing the same file there at the same time is not prevented by anything: last
write wins, silently. Give agents separate files if you can (one note each, not a shared
index).

The alternative, if that trade is wrong for you, is one project containing everything.
That keeps a single lock over the whole tree, which means one agent at a time. Both are
legitimate; pick the one that matches how you work.

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

### Titles

When a conversation starts, factotum asks `claude` — separately, in the background — for a
title of three to six words from your first message, in the language you wrote it in. Until
it arrives, or if it never does, the conversation is named by that message's first line.

```json
"sessions": {
  "titles": { "enabled": true, "model": "haiku", "effort": "low" }
}
```

All three have those defaults, so a config without `titles` titles with Haiku. `"enabled":
false` turns it off. Each title is one short call on your subscription, measured at about
five seconds.

- **Your own name always wins.** Renaming a conversation never loses its automatic title,
  and emptying the rename field goes back to it.
- **Only new conversations.** Nothing is titled at startup, on a reply, or twice.
- **No retries.** A title that fails — quota, timeout, a message like "hi" that says
  nothing — leaves the first line. Rename it if you want another.
- **What the titler can touch: nothing.** It runs with no tools at all, in an empty
  directory of its own, with none of your settings, hooks or MCP servers, and leaves no
  conversation in your `claude` history.

### Attachments

Drop a file on the box, paste a screenshot, or tap `+` (on a phone: photos and files, or the
camera). It is uploaded at once to
`~/.factotum/<env>/modules/sessions/uploads/<id>/<name>`, and when you send, its path goes at the
end of your message as an `@<path>` line — which is how the agent reads it. Up to five per
message and 20 MB each; any kind of file.

- **The agent reads it like any file.** Reading needs no approval, so an attachment never raises
  an ask, even though it lives outside the project's folder.
- **Your message is the record.** The log shows a thumbnail or a chip in place of the path, but
  what was attached is exactly the `@<path>` lines you sent.
- **Deleting a conversation deletes the files you sent in it** — from the history, with its
  project, or with a removed project's leftovers. Not the ones its agent only read, and not
  through a symlink. **Archiving deletes nothing.** If you copied a path into another
  conversation, it breaks when the first is deleted: there is no trash.
- **What is never deleted:** a file you attached and then did not send. It stays under
  `uploads/`.
- A state folder whose path has a space in it cannot carry a reference, so attaching is off
  there, and the box says why.

### Dictation

**The audio is sent to Groq to be transcribed.** It is off until you give the host a key, and if you
would rather nothing you say leaves your machine, leave it off.

The microphone sits beside `+` in the box, both when launching and when replying. Tap it, speak, tap
it again: the text lands at the end of the box, after whatever is there — including what you typed while
it was transcribing — and **it is not sent**. Read it, fix it, send it. Up to 90 seconds per recording.

To switch it on, put a [Groq](https://console.groq.com) API key in a file and point the sessions
module at it:

```sh
printf '%s' 'gsk_…' > ~/.factotum/prod/groq-api-key && chmod 600 ~/.factotum/prod/groq-api-key
```

```json
"sessions": {
  "dictation": {
    "apiKeyFile": "/Users/you/.factotum/prod/groq-api-key",
    "vocabulary": ["Factotum", "the names you say often"]
  }
}
```

- **`apiKeyFile`** is an absolute path; `~` is not expanded. The key is read once, when factotum starts.
- **`vocabulary`** (optional, up to 30 terms) biases the transcription towards words it would get wrong:
  project names, people, jargon. **A few terms do better than many** — put the ones you say most first;
  what does not fit the budget is dropped from the end, with a warning in the log.
- **`language`** (optional, a two-letter code like `"es"`). Without it the language is detected; with
  Spanish, English and a mix of both, setting it made no difference.
- **`model`** (optional) defaults to `whisper-large-v3-turbo`.

A mistake in the block switches dictation off — never the sessions — and tapping the microphone says
why. So does a host without the block, a refused microphone, or a page that is not on https. Recording
silence sends nothing: the provider invents a sentence over silence, so the phone does not ask it.

### Referencing project files

Type `@` in the box (at the start, or after a space) and the project's folder opens above it, as in
a terminal: **Tab** completes a name and goes into a folder, the arrows choose, **Enter** inserts,
**Esc** closes. On a phone, tap a folder to go in, a file to insert it, `..` to go up. Typing
filters the folder you are in. What is inserted is plain text in your sentence, and the agent's
`claude` reads the file it names without spending a tool:

- `@src/app.ts` for a file of the project, relative to its folder;
- `@docs/` for a folder (the agent gets its listing; *This folder* inserts it);
- `@/path/to/notes/x.md` inside a shared folder, which shows at the top of the list;
- `@"docs/my notes.md"` in quotes when the path has a space, or when a file has no plain
  extension (`@"Makefile"`, `@".env"`) — so the log can show it as a chip again.

What the list never shows: `.git`, `node_modules`, `.next`, `dist`, `.DS_Store`, and anything
outside the project and the shared folders — a symlink that points out of them is not listed.
Hidden files (`.something`) appear when what you type starts with a dot. A name with a `"` in it
cannot be referenced, and says so. Up to 200 names per folder: keep typing to narrow.

Not here: searching the whole project by name or by content, and opening, previewing or editing a
file from the list.

### Subagents

When the agent hands part of the work to a subagent of its own, the conversation says so: a line
per subagent where "Working…" would be — its type, what it was asked to do, and how long it has been
at it. In the background or not, it looks the same. When it ends, the log keeps a row that says how:
*done in 3m 12s* with its final report under it, *failed* with the reason, or *interrupted*.

- **What it does inside is not kept.** Its messages, its tool calls and their results stay out of
  the log, for the reason the log never keeps file contents: it would become a copy of the
  repository. Only its final report, clipped, is kept. Before, a subagent's words showed up as if
  the agent you are talking to had said them.
- **The gate still answers for it.** A subagent writes under the same boundary as the agent, and
  what the gate refuses or you approve shows in the log under its name — *general-purpose › Write* —
  with the path, never as one of the agent's own calls.
- **You cannot write until it is over.** The turn is not done while a subagent runs, even one in the
  background: the box comes back when the whole run has finished.
- **Cancel stops it with everything else**, and its row says *interrupted*. Replying afterwards
  starts a new turn; the interrupted one never comes back as running.

### Questions

The agent can ask you a batch of decisions with options you tap, instead of asking in prose: one to
six questions, each with two to six options and a description under each, one option or several,
and "Other…" for an answer in your words. It arrives as a notification that says the project and
how many questions — never the questions themselves — and as a notice in the conversation. You can
send with gaps: what you leave blank reaches the agent as *unanswered*, and it is told that means
nobody chose. On a computer the sheet works from the keyboard: ↑/↓, 1–6, Space or Enter, Tab between
questions, ⌘/Ctrl+Enter to send.

- **The window is the ask's**, a little under an hour. If nobody answers, the log says so and the
  agent is told there is no decision and to end its turn; the session finishes normally and you carry
  on by writing. Nothing is cancelled for you.
- **Cancel releases it at once**, and so does stopping factotum; the log says which.
- **A subagent can ask too**, and the sheet and the log say which one.
- **Without push there are no questions**: the agent is told you cannot be reached and asks in
  prose, as before.
- **Any screen of the conversation can answer**, the daemon's own machine included, with or without
  the notification: the notice in the dock or the "Waiting for your answer" row opens the sheet, and
  Escape closes it without losing what you picked. Unlike an approval, answering a question grants
  nothing, so it needs no token; the log says *answered without the notification* when that is how it
  came. The token from the notification is still never written to disk.
- **In `dev`, `FACTOTUM_ASK_TIMEOUT_SECONDS`** shortens the window — for questions and for the
  permission ask alike — to anything from 30 s up. `prod` ignores it and says so.

Why it is an MCP tool served by this module, and what it depends on in the CLI: ADR-0013.

### Background services

Ask the agent for something that must keep running — a dev server, a long copy — and it survives the
end of the turn. The CLI kills its own background shells when a turn ends, so factotum runs them
instead: the agent calls `start_service`, and a background `Bash` is turned away with a message that
points it there (it never shows in the log). The conversation gets a row where the service was started,
and a line under the log for every one still alive — also when the conversation is at rest. Tap either
for the last 50 lines of its output, Refresh, and **Stop**, which asks first.

- **It lives until** it ends by itself, you or the agent stop it, its limit runs out (8 hours unless the
  agent asked for less or more, at most 24), you cancel or delete the conversation, or factotum stops.
  After a restart the row says *stopped by restart*; it is never started again for you.
- **A later turn can read it.** "How is the server doing?" makes the agent call `service_output`; it
  sees the real lines. The agent's service tools only work while its turn runs; yours always do.
- **The output stays on disk**, in the conversation's folder, at most two files of 1 MiB, and is deleted
  with the conversation. The log keeps what was run and how it ended, never what it printed — unless the
  agent quotes it in its answer.
- **It does not hold the project.** A new conversation or a reply starts while a service runs; two
  servers on one port is the command's problem, and its row says *failed* with the error.
- **It runs in your login shell, interactive**, so it finds what your terminal finds (`pnpm`, your node
  version). Its first lines may be your prompt's start-up noise.
- **`nohup … &` in an ordinary command is not caught**, and factotum cannot see or stop what it starts.
  The agent is told not to; Cancel still stops it with the agent.

Why the daemon owns them, and what the MCP route trusts: ADR-0014.

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

## The eleven things this does NOT guarantee

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

**11. A recording is readable on disk while it is being transcribed.** The kernel writes the audio
to `<state>/modules/sessions/.incoming/` with your umask — usually `0644` in a `0755` folder — and deletes
it before answering, including when transcription fails. For those seconds, another user of the same
machine could read it ([ADR-0015](adr/0015-dictation-in-the-sessions-module.md)).


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
- **Every agent that can use a tool goes through the permission gate.** The one `claude`
  factotum starts without the gate's hook is the titler, and it runs with `--tools ""`: it
  has no tool to ask about.

---

## When it goes wrong

| What you see | What it means |
|---|---|
| `sessions` disabled in `factotum doctor` | The config fragment is wrong; the reason is printed |
| A project marked *Folder missing* | Its folder is not there. It launches nothing until it is back; the others are fine |
| Add project answers *no device can approve* | No phone is subscribed. Subscribe one in Device, or add it by hand with the daemon stopped |
| `409` when launching | The site already has a live session, or it is a git repo that is dirty or behind. The screen offers to go to the session, cancel it, or launch anyway |
| A session `failed` right after a restart | It was running when the daemon stopped. The log is intact up to the last event that was written |
| A denied write you did not expect | The site is probably narrower than the job. Widen the site rather than widening the gate |
