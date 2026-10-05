# 17. The launchable list comes from the CLI; its arrangement from a note

**Status:** accepted. Builds on the catalog of the session engine (`sessions.catalog`), which stays.

## Context

The composer could only launch what `sessions.catalog` listed, and typing a skill meant remembering its
name. The CLI already knows what exists: it says so on its first line. Measured on the installed CLI:

- **The `system/init` line lists three arrays**: `skills`, `agents` and `slash_commands`. Factotum used to
  read that line and throw it away.
- **`slash_commands` mixes built-ins with skills.** `clear` and `compact` sit next to real skills, and
  nothing in the line says which is which. Subtracting `skills` leaves "commands", some of them the
  owner's and some the CLI's own, with no way to tell them apart.
- **Names starting with `__` are CLI internals** (for example a remote-workflow helper). They are not
  data errors and not for the owner, so they are skipped silently.
- **A resumed session stays the agent it was launched as**, without `--agent` being passed again.
- **A session launched as an agent announces the same list** as any other, so any session can refresh it.

Where a skill is *for* (when to call it, how it groups with others) is not in the CLI at all. It lives in
the owner's head, or in a note.

## Decision

- **The CLI decides what exists.** `run.ts` hands the first `system/init` line of each process to the
  engine (`onInit`, a throw there never costs the turn). `announcedOf` normalises it, dropping names that
  are not invokable and anything past 1,000 per list, and the result is kept in
  `<state>/modules/sessions/announced.json`, rewritten only when the lists or the version change. A
  malformed line never replaces a good list with an empty one.
- **`--agent` only with an announced name.** Launching as an agent is accepted only from a free-prompt
  entry, and only with a name the CLI announced; before any list is known it is refused. The reply path
  needs nothing: the session stays the agent.
- **Classification, in this order:** in `skills` it is a skill; else in the commands it is a command; else
  in `agents` it is an agent. A note row marked as an agent looks only among agents, so a skill and an
  agent with similar names never get confused.
- **The note only arranges.** `sessions.skills.notes` is an absolute path to a Markdown file the owner
  writes (format in [running-agents.md](../running-agents.md#skills-with-)). It orders the list and
  gives each entry a "why" and a "when". A name in the note that the CLI does not announce is reported as
  stale and never shown; a name the CLI announces and the note does not mention goes to "Unsorted".
  The note is optional, is read with a `stat` check so an unchanged file is not parsed again, is capped at
  256 KiB, and a missing, oversized or broken one degrades to "no note" and one reason. It never breaks
  sessions: an invalid `sessions.skills` block turns the note off, not the module.
- **Pins are per project**, a `pinned` list of names in `projects.json`, changed with
  `POST /projects/:id/pins`. Like a rename, it moves no boundary and asks for no approval.
- **The composer's "/" is only a way to type a name.** The text still goes to the CLI untouched; the list
  helps write `/name` and nothing more. Only a `/` at position 0 opens it, because the CLI only expands a
  skill at the start of the text.

## Consequences

- **Commands only appear if the note names them.** Because built-ins cannot be told from the owner's
  commands, listing every command would put `clear` and `compact` in the picker. Without a note you get
  skills and agents, all under "Unsorted", and no commands. This is also the only way a built-in stays out
  of the usage screen's "never used".
- **The list arrives with the first session.** Until one has
  started, `GET /skills` says the list is unknown and the picker is empty. After a plugin is installed
  the list stays old until any session runs, including one launched as an agent.
- **The note is the owner's personal file**; nothing in the repository quotes it.
- **The catalog stays.** It is still how a command or an agent is launched from the "What to run" select;
  with a single usable entry the select is hidden.
- A usage count (`GET /skills/usage`) is derived from the logs that already exist; no log gains an event
  class.

## Going back

Nothing is migrated: `announced.json` is new, `pinned` is optional on disk, and a `meta.json` without
`agent` reads as no agent. Going back to a daemon from before this change:

- **It deletes `pinned` from `projects.json`** on its first write, because the schema drops keys it does
  not know. **Copy `projects.json` first** if you want to keep the pins.
- **It deletes `agent` from every `meta.json`**, always, on that session's first `patchMeta`, because its
  reader does not list it. A conversation launched as an agent then reads as a plain one.
- It leaves `announced.json` unread.

## Alternatives considered

- **Reading `~/.claude` directly.** Duplicates what the CLI resolves (plugins, project skills, precedence)
  and breaks the day the layout changes.
- **A field in each `SKILL.md`'s frontmatter** for the "why" and "when". Impossible for third-party plugin
  skills, and it would put the owner's personal grouping inside files they do not own.
- **A probe at startup** that launches the CLI to read the list. It would spend subscription quota on
  every start, at a cost nobody has measured.
- **Classifying with a model.** Slower and nondeterministic, for a job a note does in one table row.

## What this does not do

- Expand `/name` in the middle of a sentence; the CLI does not either.
- Tell an owner's command from a built-in one.
- Launch anything from the Skills screen: it only reads.
