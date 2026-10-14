# 21. A task board on one host, and the edges between modules it needed

**Status:** accepted

## Context

The owner kept tasks in weekly notes, and the system fell apart: one week left 23 boxes open, the next
week's note was never written, and work for a client never entered it at all. The `tasks` module is a
kanban board that replaces those notes — six columns, weekly cycles closed on Monday, a Triage for
everything the AI creates, capture by text or voice, «What's next?», reminders by push, and agents that
create tasks and are launched from a card.

It is the second module after `sessions` that needs something from another module, and the first that
needs it from the screen. Four questions this repository had left open came due together: where one
list lives when there are two hosts; how another module serves MCP tools (ADR-0013 waited for «the
second consumer»); how one module's screen calls another (ADR-0005: «the client one is still open»);
and where the dictation goes when a second module wants it (ADR-0015 foresaw the move).

## Decision

### The board lives on ONE host, in one JSON file — not in a database

A board is one list: two boards would split it again, which is the problem it removes. It lives on the
host that is always on (ADR-0018 measured the Mac asleep; a reminder needs a process awake at its hour).
The other host runs `tasks` in **relay** mode: it keeps no board, its screen jumps to the board host's
through the proxy, and its sessions' `create_task` is forwarded there (`ctx.peers`, ADR-0019).

The board is **one JSON file** written atomically (temporary file, `fsync`, `rename`, `fsync` of the
folder), held in memory, every change through one queue that runs an op on the board OF THAT MOMENT.
Hundreds of cards, a few thousand in a year: a file of a couple of MB. Measured: `view()` of 2 000 cards
takes ~2 ms. A cloud database was considered and refused: a public module should not need an account,
client tasks should not leave the machine, the board must work without internet inside the tailnet, and
a table needs a credential. If size ever matters, `node:sqlite` comes with Node and is the next step —
another ADR. A file that does not pass the schema is never overwritten: it is copied aside and only
`tasks` switches off. **There is no backup**, by the owner's decision (`docs/tasks.md`).

### Tool families from other modules on the sessions' MCP server (amends ADR-0013)

ADR-0013 served one tool from one module and left the contract to «the second consumer». This is it,
and the shape is the services' one, generalised: `McpDeps.extra` is a list of **families**, each
`{ tools(), call() }`, listed after `ask_owner` and the services and **read on every `tools/list`**. A
name that would shadow `ask_owner`, a service or an earlier family is ignored, once, in the log.

**The guard stays in `sessions`**, which is the module that knows what is alive: only a live session
reaches a family, with the `siteId` it runs in; anything else is `NOT_RUNNING` without calling it.

The composition root wires it through a **link**: an object that starts empty and that `tasks` fills
LAST in its `start` and clears in `stop` — the shape of `hookUrl`, there for the same reason. While
`tasks` is off, starting or failed, `create_task` is simply not on the list.

### The client edge between modules: `peerModule` and `openModule` (closes ADR-0005's open edge)

Two members of `ModuleViewProps`, built by the shell:

- `peerModule(id, host)` — another module's api on a host, or `undefined` when the server serving the
  app does not run that module (the shell knows from `GET /modules`);
- `openModule(id, rest, options)` — go to another module's screen. The router follows no `href`, so it
  is `navigate` with another id.

**A contract, not a boundary.** The page is one origin and any script on it can call any route. What the
edge gives is a sanctioned, typed way to say «this screen uses sessions», declared by structure in the
module's own `contract.ts` like everything else the shell hands over, instead of a hand-built URL or an
import of another module's folder (still forbidden, and checked by a `grep`).

**Two naming systems meet at it.** What the board stores says `null` for the board's host; what the
client speaks says `undefined` for the host serving the app. They stopped coinciding the day the Mac's
app showed the board of the other host. Every host the task screen reads or writes goes through two
pure functions (`modules/tasks/client/where.ts`), tested from both apps, so the same project is the same
host whichever app looks at it.

### `modules/shared/`, and the dictation moves into it (fulfils ADR-0015)

The dictation's client moved from the sessions module to `modules/shared/dictation/` as ADR-0015
wrote it would: with its own two-member `Api`, a copy of its four glyphs and its own CSS (`.d-*`, its
own `d-spin`). **A shared folder imports nothing from any module, not a glyph nor a type**; it receives
its `api` as an argument. Its server side stays in `sessions`: the task screen's microphone calls the
sessions module of the serving host through `peerModule`.

The launch errors of `sessions` were NOT moved: «Run agent» needs four functions, and they were copied
into `tasks`, declared as a copy. Moving them would be another migration without a second consumer that
asks for it.

### The first interval with a wall-clock hour — and why here it is right (against ADR-0018)

ADR-0018 made the inbox run on demand and nothing on a schedule. Reminders cannot: a reminder IS an
hour. So one interval of 60 s, on the kernel's timers, compares the board with the clock — never a
`setTimeout` per reminder, which cannot pass ~24.8 days and does not run while the machine sleeps. One
write marks what goes out BEFORE it is sent: a restart in between loses at most one notice and never
sends one twice. Nothing is marked while no device can be reached. A reminder found more than 24 h late
(the daemon was down) is shown as missed and not sent.

### The types declared twice, a fourth time

`packages/tasks` declares the board's types and `modules/tasks/types.ts` declares them again by hand,
because a module imports only `@factotum/core`; the two meet at one assignment in `main.ts`, where the
compiler checks that the factory, the link and the tool family fit. It is the arrangement of ADR-0005
and ADR-0018, now in four places. It is kept, with the cost known: a field added on one side and not
the other fails the build, which is what it is for.

## Consequences

- The AI never acts on the board: what it creates lands in Triage, and «What's next?» only proposes,
  from real cards it is shown by short keys and checked against when the answer lands.
- `create_task` is capped at ten per session, counted on the board in the same write as the card.
- `POST /agent-tasks` has no credential, like every route of factotum (ADR-0002): anyone on the tailnet
  can file cards in Triage, and lift the cap by inventing session ids. Accepted, and written down in
  `docs/tasks.md`: the worst it does is a Triage to clear.
- A dead board host means no board, no capture and no reminders — the same risk two hosts already
  accepts; reminders missed while it was down are sent on return, within 24 h.

## What this does not do

- Synchronise with Trello, Linear or anything outside; import the old weekly notes; write to the vault.
- Keep a board on each host, or a backup of the one.
- Let an agent's session move, edit or close a card, or a finished session move its card.
- Recurring tasks, a scheduled «What's next?», or a reminder without an hour.
