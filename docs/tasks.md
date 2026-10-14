# Tasks: a kanban board for everything you have to do

The `tasks` module is a board at `/m/tasks`: six columns (Backlog, Todo, In progress, Blocked, Done,
Canceled), weekly cycles that close on Monday when you open the app, a **Triage** for everything the AI
creates, capture by text or voice, **What's next?**, reminders by push, and agents — the ones you run in
factotum — that create tasks and are launched from a card.

Why it is built this way is [ADR-0021](adr/0021-tasks-board-and-module-edges.md).

## 1. Where the board lives

**On one host: the one that is always on.** A board is one list; two hosts with a board each would split
it. With two hosts (see [hosts.md](hosts.md)), put `tasks` in **board** mode on the host that does not
sleep, and in **relay** mode on the other:

```jsonc
// on the host that keeps the board (e.g. a Linux box)
"tasks": { "enabled": true, "mode": "board", "timeZone": "Australia/Sydney" }

// on the other host (e.g. a Mac that sleeps)
"tasks": { "enabled": true, "mode": "relay", "relayTo": "omarchy" }
```

- `timeZone` is the zone the weekly cycles and the reminders follow. Optional: the zone of the process
  by default. Check it on the board host — a wrong zone moves Monday.
- `model` is the Claude model that reads captures and answers «What's next?»; `sonnet` by default, the
  cheapest that met the schema and the dates in the measurement. `effort` is optional.
- `relayTo` is the **machine name** of the board host, as `/hosts` lists it.

On the relay host, **Tasks** in the drawer opens the board of the other host through the proxy. If that
host is down, the screen says so. Agents running on the relay host still create tasks: they are
forwarded to the board host.

## 2. Triage, and what the AI does

Everything the AI creates lands in **Triage**, never on the board. You accept it to Todo or Backlog,
edit it first, or discard it.

- **Capture.** Type a task in the field at the bottom (or the top, on a wide screen) and press **Enter**
  (or ✦): the card is saved in Triage at once and Claude fills in a clean title, the due date («el
  viernes», «next Monday»), the priority, and the area and project — **only from the areas already on
  the board and the projects factotum knows**; it never invents one. The **+** button adds the text as a
  card straight to the column, without AI. The microphone dictates into the field, with the dictation of
  the sessions module (if it is configured).
- **What's next?** proposes up to seven cards for today, each with why, and only cards that are on the
  board. It runs when you press it, never on its own.
- **Agents.** A session you run in factotum can call the tool `create_task`: the card lands in Triage
  with the session and its project. **At most ten per session.**
- **Run agent.** A card with a project can launch a session on it, with the card as the prompt (editable).
  The card moves to In progress and remembers the session. When the session ends, the card stays where it
  is.

The AI never moves, edits, closes or deletes a card you accepted.

## 3. What goes to Claude, and what goes to the push

- **A capture:** its text, today's date and time in the board's zone, the names of the areas, and the
  names of the projects. Claude runs with no tools and no session.
- **What's next?:** up to 100 cards — the open cycle, what is overdue or due within a week, and twenty of
  the backlog — with their title, area, status, priority, due date and estimate. **Never their notes or
  subtasks.**
- **A reminder:** «Reminder» and the card's title, cut to 120 characters, through your browser's push
  service. Nothing else of the card.

The daemon's log carries ids, times, tokens and cost — never a title, a note or the text of a capture.

## 4. Reminders

A reminder is an explicit hour: a due date alone never reminds. The card offers two shortcuts — the due
date at 9:00 and the day before at 18:00. The board host checks every minute and sends the push with
the app closed; tapping it opens the card. A reminder is sent once. If the daemon was down at the hour,
it is sent when it comes back **within 24 hours**; later than that the card shows it as missed. While no
device is subscribed to notifications, reminders wait.

## 5. The file, and that there is no backup

The board is one file: `~/.factotum/<env>/modules/tasks/board.json` on the board host, readable only by
you. **There is no backup and no export** — a disk that dies takes the board with it. Copying it by hand
is a `scp`.

A file that does not pass its schema is **never overwritten**: it is copied to `board.json.bad-<date>`
next to it, and only `tasks` switches off, with the reason in `GET /modules`. Fix the file or move it
away, and restart.

Done and canceled cards are kept, forever, in the history of their cycle.

## 6. Who can create tasks

Like every route of factotum ([ADR-0002](adr/0002-no-credential-private-bind.md)), the board has no credential:
anyone on your tailnet can reach it. In particular **`POST /modules/tasks/agent-tasks`** — the route the
relay host forwards to — takes the session id from its body: **anyone on the tailnet can create cards in
your Triage, and go past the cap of ten by inventing session ids.** The worst it does is a Triage to
clear, and nothing reaches the board without you accepting it.

## 7. For development: moving the clock

To see a Monday close without waiting for Monday, start the dev daemon with the board's clock moved:

```sh
FACTOTUM_TASKS_NOW_OFFSET_DAYS=7 factotum start --env dev
```

It moves only the `tasks` module's clock — cycles, reminders and the date the AI resolves against —
by whole days, from −366 to 366. It is read **only with `--env dev`**; in prod it is ignored, with a
warning in the log.
