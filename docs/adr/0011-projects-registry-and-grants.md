# 11. Projects live in a registry only the daemon writes; widening from the app needs an approval on the phone

**Status:** accepted. Amends [ADR-0004](0004-config-errors-degrade.md) for one case (a missing
folder), the comment on `inspectSite`, and §4 of [ADR-0010](0010-pending-attention-in-the-client.md).

## Context

Projects (sites, in the code) were declared in `config.json`. A module cannot write the config or
restart the daemon, so adding one needed the terminal, an edit, and a restart; `factotum site add`
did the edit and the restart. The folders in prod were test folders under `/tmp` that macOS
deletes, and one missing folder disabled the whole sessions module, on purpose.

Any process on this machine can call the module's routes (the `Origin` check stops other browsers,
not local processes), and an agent's `Bash` is not checked against the boundary. Adding a project
widens what an agent may write. So whatever adds one from the app must not be callable by an agent.

## Decision

### 1. The registry (spec D1)

- Projects and shared folders live in **`~/.factotum/<env>/modules/sessions/projects.json`**.
  The config's `sites` and `sharedPaths` **seed it once**, literally, only when the file does not
  exist (`ENOENT`); from then on what is only in the config is not loaded, and the start says so.
  Any other read error, or an invalid envelope, is **broken**: the module runs with no project, the
  file is never written over, every change answers 409.
- **One schema.** The registry is built from `siteSchema` and `boundaryPath` in
  `modules/sessions/config.ts`. The shape is checked in the module; the engine checks only the disk.
  The engine sees a read-only view and hands back edits as data (ADR-0005, the note below).
- It **degrades per entry**: a bad entry is skipped, said (`skipped` in `GET /projects`, the
  projects screen, `site list`, `doctor`) and **written back as it was** at every write.
- **The daemon is its only writer**, from memory, in a queue: a write goes to a copy, and memory
  follows only once the write finished. A hand edit while the daemon runs is ignored and
  overwritten; with the daemon stopped, it loads at the next start.
- **The CLI reads it.** `factotum site list` shows it; `site add|rm` write nothing, exit 1 and say
  how: from the app, or without a phone `factotum uninstall`, edit the file, `factotum install`
  (or stop and start `factotum start`). `site add` still switches the module on where it never
  was. `init` switches it on with "Free prompt".
- The module computes `home` with **`os.homedir()`** and `factotumRoot` three levels above its
  `stateDir`; a test in the composition root checks that against the kernel's `statePaths`.

### 2. A missing folder fails alone (spec D2) — the amendment to ADR-0004

A folder that is not there no longer disables the module. Each project carries its last check
(`ok` or `missing`), checked again before a launch, a reply, a read and the projects list, each
check with a 5 s ceiling and one in flight per folder. A `missing` project launches nothing and its
conversations are not read (409 `site-missing`); the others carry on. A session **already running**
keeps the boundary it started with: the gate uses the last `ok` site, not the latest check.

This only narrows the boundary, which is why it needs no approval. `inspectSite` still throws; the
engine calls it through `checkSite`, which turns the throw into `missing` for that site alone.

### 3. Adding asks the owner's phone (spec D3)

A request for a project or a shared folder is **an ask with no session**:

- The module checks the shape (400). The engine, in order: registry broken → 409; history index
  not ready → 409; three requests already waiting → 409; no device can be reached → 409 (naming
  Device and the edit by hand); then the disk, on the **canonical path** (the `realpath` of the
  nearest existing ancestor plus the rest; case-insensitive on macOS): it must exist and be a
  folder, and may not be `/`, the home, **`~/.factotum` or the checkout the daemon runs from**, nor
  anything inside or above those two, nor (for a project) equal, contain or sit inside another
  project, missing or not. A shared folder may sit inside a project, and may not repeat. What is
  registered is the **resolved** path; the id comes from the resolved folder's name, by the
  module's rule, and may not be one that still has history of a removed project.
- Only then a token (`randomBytes(32)`, in memory only) and a push: `Add project · <name>`, never
  the path, `until` ten minutes later. The response is `202 { requestId, expiresAt }`, built field
  by field; the token is in no response and on no disk.
- Approving is answering with the token. The **first** answer disarms the deadline and runs the
  write **inside the registry's queue**, checking the disk again against the registry as it is by
  then, with the same 5 s ceiling, and refusing if the resolved path moved. Every answer returns
  that same result. It ends in "Added · <name>" or "Could not add · <name>" — without the reason,
  which can carry a path; the reason is on the screen, through the request's status.
- Shared folders change only with no session running: asked, approved or removed. The gate's list
  changes only then, at start, and when a missing shared folder comes back with nothing running.
- Renaming, recolouring, removing a shared folder and deleting a project need no approval. Deleting
  a project deletes its conversations under a `removing` lock, never its folder.
- **The order of the projects and the owner's categories** need none either: they are cosmetic,
  like a name. The order is the order of `projects` in the file; `categories` is an optional list
  of `{ id, name }` and a project's optional `category` names one. They are set **whole**, by
  `POST /project-layout` — every project once, checked inside the queue — so two screens never
  interleave into an order neither asked for: the stale one is a 409 and reloads. A bad category
  is skipped and kept like any entry; a category a project cannot use costs it the category, never
  its place.

## What this does not contain — and why that is proportionate

- **R0, an agent with a shell.** It can write `projects.json` or the config and wait for a
  restart, as it could already write the config. This adds no new way: what is written while the
  daemon runs is ignored and overwritten. It is not containment and does not claim to be.
- **R1, an agent reaching the token.** The token travels exactly where an ask's does (ADR-0008,
  ADR-0010 §3): in the push, and in the IndexedDB of a device that is not this machine. The worker
  drops `grantId` on this machine as it drops `askId`. What is at stake is more (a folder, not one
  write), which is why a request adds "Added" (a second signal), a ceiling of three, and the
  Device warning. Not delivering approvals to browsers on this machine needs the kernel; the owner
  judged the push level enough (spec, open question 1, 2026-09-29).
- **Deleting needs no token.** A local process can delete conversations and projects' histories
  through the routes (`POST /sessions/remove`, `/projects/:id/remove`, the removed ones). That is
  the spec's rule — narrowing needs no approval, and deleting asks only the screen — and it loses
  data, never files or boundary: a folder is never touched, and an agent with a shell could
  already delete `~/.factotum` itself. Written here so it is a decision and not a gap.
- **One request per folder, and the parent in the notice.** A second request for a folder already
  waiting is a 409, so three copies cannot fill the ceiling; and the notice says
  `Add project · web (in code)`, because a folder's name alone is the caller's to choose.
- **The checkout the daemon runs from is refused.** An agent working in it could rewrite the gate
  for the next start. To work on factotum from factotum, register another clone or worktree.

## Amendments

- **ADR-0004.** A missing project folder degrades that project, not the module (§2 above).
- **ADR-0010 §4.** `until` has **two** consumers now: the ask and the folder request. The comment on
  `NotificationMessage.until` in `packages/core/src/module.ts` ("Its one consumer is the ask") is
  out of date; `core` is not touched by this spec, and it is fixed by the next one that opens it.

## Reverting

Delete `projects.json` and go back to the previous commit; the config did not change. (Going back
only past the categories needs nothing: the older reader ignores `categories` and `category`, and
its next write drops them — the order stays.) **Projects
added from the app live only in `projects.json`**: copy them into the config by hand before
reverting.
