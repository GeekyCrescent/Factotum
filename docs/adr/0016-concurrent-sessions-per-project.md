# 16. Several sessions at once in a project, opt-in per project

**Status:** accepted. Amends the session engine's design D8 (spec 2026-09-14-motor-de-sesiones): "at
most one live session per site".

## Context

A project held one lock, so it held one live session: launching or replying while another ran was a
`409`. For a code repository that is the protection that matters — no second agent edits the tree
under the first. For the owner's notes vault it only got in the way: most of what is asked there is
short and unrelated, and waiting for one answer before asking the next protected nothing worth
having.

Everything else in the engine was already keyed by session, not by site — the live table, the gate's
boundary, notices (`tag: sessionId`), questions and background services. The lock was the only piece
that enforced "one per site".

## Decision

- **A switch per project, in the registry** (`projects.json`, `concurrent: true` or absent), set from
  the app's edit dialog. Off by default for every project. Not in `config.json`, and not global.
- **Turning it on or off needs no approval on the phone.** It moves no boundary: each session still
  writes only in its project and the shared folders. It is in the same class as renaming
  (ADR-0011), by the owner's decision.
- **The lock becomes one file per holder**, `locks/<siteId>/<holderId>.json`. The MODE belongs to the
  asker and is never stored: an exclusive acquire loses to any holder; a shared one loses only to
  `removing`, to the old layout, or to its own id. Launch and reply ask in shared mode when the
  project's switch is on, read inside the lock's queue so a switch flipped a moment ago is the one
  that counts. Deleting a project always asks exclusive.
- **A queue per site, in the daemon, decides.** With one file per holder, "is anyone else here?" is a
  directory read and then a write, which `O_EXCL` alone cannot make atomic. A queue in this process is
  enough because an environment has one daemon (the port, and reconcile's row 1 as a second
  opinion). A rejected task does not leak into the next one, so a disk error cannot close the site
  until a restart.
- **Reconcile works one lock at a time**, with row 1 ("a live daemon pid") as a pass of its own before
  any other row, so with several locks it still touches nothing when it gives up. It reads the old
  layout (`locks/<siteId>.json`) and releases it by the same rows.
- **Turning it off cancels nothing.** The running sessions keep their locks until they end; until
  then every new launch or reply in the project is a `409` naming the oldest one.
- **A launch beside siblings does not check freshness**, and its log says so on its first line. With
  siblings running, the tree is dirty with their edits and the warning would fire every time — the
  same reason a reply never checks.

## Consequences

- **In a project with the switch on there is no protection between agents**, as in a shared folder:
  two sessions editing the same file, the last write wins, silently. The owner accepted that for the
  vault; a code repository should keep the switch off.
- **`stop()` still leaves every lock on disk**, now one per running session, and the next start releases
  them through row 4.
- **Going back to a daemon from before this change with locks of the new layout on disk** is the one
  step that is not automatic: that daemon does not see the per-site directories. Stop it and empty
  `~/.factotum/<env>/modules/sessions/locks/` by hand first. Going forward needs nothing: the old
  layout is read and released.
- Reconcile is O(locks), which is O(sessions running when the daemon died), instead of O(sites).

## What this does not do

- Prevent or report two sessions writing the same file.
- Cap sessions per project or per machine, or warn about the quota several sessions spend.
- Change when shared folders may change: still only with no session running.
