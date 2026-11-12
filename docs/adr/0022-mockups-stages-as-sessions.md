# 22. Mockups: stages as sessions launched from the screen, and deployed to Vercel

**Status:** accepted

## Context

Two or three times a month a client of BWR asks for a mockup — from an RFP, a meeting, a few bullets.
Two of them were made by hand, and both ended with the same documents (a scope, visual directions with
checked contrast, a presenter guide) and the same work folder (the directions as HTML, a Next.js app
deployed to Vercel). Each took more than a day or two; the time went into understanding the input, the
visual direction with the animations that sell it, and the build.

The `mockups` module takes a request from its inputs to a deployed URL by fixed stages — brief,
concepts, plan, build, deliver — each done by an agent session, each leaving a document in the owner's
vault, with the owner deciding at the gates from the phone. After delivery, changes run on a track of
their own. It is the third module after `sessions` and the second consumer of the edges ADR-0021 opened.

## Decision

### A stage is a session the SCREEN launches, and the session hands in through an MCP family

A module cannot launch a session from the server: `engine.launch` is reachable only through
`POST sessions`, and the one server edge between modules goes the other way (ADR-0021's families). So
the screen launches, as «Run agent» does on a card: it asks `mockups` for a run (`runId`, site, prompt,
title), launches with `POST sessions { …, force: true }` on the module's host, links the session to the
run and titles it. `force` always: the module has just written in the vault (`_versions/`, `chosen:`, a
hub, the map), and without it `sessions` answers that the tree is stale.

The session ends by calling **`submit_stage`**, a tool of the `mockups` family on the sessions' MCP
server. It refuses — changing nothing, with a text the agent can act on — a run that is not alive,
another session or site, a missing or empty document or one outside the mockup's folders, the wrong
number of options, a URL that is not a deployment of THAT stage's Vercel project, and anything the
real-data guard finds. Accepted, the stage waits at its gate and ONE push goes out, with the mockup's
name and the stage, nothing else.

A session that ends without submitting does not kill its run: the stage shows «stalled», with «Open
session» (answer and carry on: its late submission is accepted) and «Retry». A run whose screen died
before linking is marked stalled by a sweep after ten minutes — never abandoned, because the session
may be alive. No stage is launched or retried by the module on its own.

### The documents in the vault, the code in the work folder, the state in one file

The documents are the owner's and live in `<project>/mockup/` of the vault, where they are edited in
Obsidian; the module reads them, copies them to `_versions/` before a redo, and writes one key in them
(`chosen:`). The inputs, the directions and the app live in the project's work folder. The state —
stages, runs, decisions, URLs — is `mockups.json`, the arrangement of `tasks` (ADR-0021): atomic writes,
one queue, a damaged file copied aside and only `mockups` switched off. A new project gets its hub and
its line in the day-job map, written once by the module; the vault, the map file, the work root and its
own state folder are the only places it writes, all declared in the config.

### Directions and the app on Vercel, because the kernel serves no HTML

ADR-0012 serves anything that is not an image as a download, under a sandbox: an HTML direction cannot be
shown from the module, and nothing forwards a `next dev` port. So the plan deploys `directions/` (plain
static pages) and the build deploys `mockup-app/` to Vercel previews, and the gates open those URLs on
the phone. Vercel was already the habit of the mockups made by hand.

Measured (A3): a new Vercel project is born protected, and its previews ask for a login; on the Hobby
plan the production alias is public whatever the protection says, and a password is a Pro feature. The
owner chose **no protection**: the stage removes Vercel's after checking. The order matters:

- **a preview** deploys with the protection ON, calls `check_real_data` (the guard, changing nothing),
  and only if it is clear turns the protection off;
- **production** cannot be held back by the protection, so `check_real_data` comes BEFORE
  `vercel deploy --prod`.

A copy of real data should never be served even once: Vercel's edge keeps serving a deployment for
minutes after it is removed (measured in G5 and again in L3). The order is in the prompt, not enforced
by the module, which never runs `vercel`: a session that disobeys can publish first. That limit is
declared in `docs/mockups.md`.

### The real-data guard is a hash comparison that fails closed

Real client samples are uploaded apart (`inputs/private/`); only the plan may open them, to give the
invented data their shape. The guard hashes every file there against every file of `directions/` and
`mockup-app/`; a copy is refused, and so is a tree it cannot finish (20 000 files or 60 s). It catches a
literal copy and nothing else: a paraphrase, an extract or a retyped value passes, and the plan's gate is
where the owner catches those.

### One host

`mockups` runs on the Mac, where the work folders, the vault and `vercel` are; there is no relay mode.
A stage session handed off to the other host (ADR-0020) no longer sees `submit_stage`, ends stalled, and
is retried.

### Two moves into `modules/shared/`

The screen renders Markdown and launch errors, which `sessions` and `tasks` already had. As ADR-0021's
rule says for a second consumer: the Markdown renderer moved from `sessions` to
`modules/shared/markdown/` (with its `.s-md*` CSS, unrenamed), and the launch errors copied into `tasks`
moved to `modules/shared/launch-errors/`. `sessions` keeps its own `errors.ts`, which mixes launching with
other things and has sixteen importers.

## Consequences

- Every URL a mockup produces is public: the directions, each preview, production. Deleting a project
  does not unpublish at once.
- The prompts are the module's (`packages/mockups/src/prompts/`), snapshot-tested; their quality is
  measured with real requests, not by the tests.
- A `vercel` without a login does not fail: it starts a device login and waits. A stage that meets it
  ends stalled after several minutes (measured in H2).
- The types are declared twice, a fifth time (ADR-0021), and meet at one assignment in `main.ts`.
- The `sessions` titler logs the title it makes from a prompt, and a change's prompt carries the
  client's request: the daemon log can hold a summary of it. The module's own log lines carry ids only.

## What this does not do

- Send anything to the client, or share links; protect a deployment.
- Edit a document on the screen; delete or move a mockup (it is archived).
- Launch or retry a stage without the screen; cancel a session from the mockup.
- Serve HTML from the module, or preview `next dev` on the phone.
- Run on more than one host, or hand a stage session to another.
