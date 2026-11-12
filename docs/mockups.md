# Mockups: a client's request taken to a deployed URL, by stages

The `mockups` module is a screen at `/m/mockups`. A mockup starts from inputs — an RFP, a Word file,
meeting notes, a few dictated bullets, brand assets, sometimes real client data — and goes through five
stages, each done by an agent session that leaves its work in your Obsidian vault:

| Stage | Runs in | Leaves | You decide |
|---|---|---|---|
| **brief** | the vault | `01-brief.md` | approve, or redo with a comment |
| **concepts** | the vault | `02-concepts.md`, 2–3 angles | choose one, or redo |
| **plan** | the vault | `03-story-and-pages.md`, `04-data.md`, `05-visual-direction.md`; 2–3 directions as pages on Vercel | choose a direction (opening its page), or redo |
| **build** | the work folder | the app in `mockup-app/`, deployed to a Vercel preview | approve (opening the preview), or redo |
| **deliver** | the work folder | production on Vercel, `06-presenter-guide.md` | — |

Each gate sends a push («<name>: <stage> ready») and waits for you, as long as it takes; approving or
choosing launches the next stage. After delivery, **Changes** takes the client's change requests, each
with its own preview and gate, then a redeploy to production and a line in `changes.md`.

Why it is built this way is [ADR-0022](adr/0022-mockups-stages-as-sessions.md).

## 1. Turning it on

It runs on **one** host, the one with the vault, the work folders and `vercel` (a Mac, in the setup it
was made for). It needs `sessions` on that host.

```jsonc
// ~/.factotum/<env>/config.json
"modules": {
  "mockups": {
    "enabled": true,
    "docsSiteId": "personal",
    "vault": {
      "projectsDir": "~/Obsidian/Personal/01-projects",
      "mapFile": "~/Obsidian/Personal/06-maps/day-job/day-job.md"
    },
    "workRoot": "~/Work/Projects",
    "model": "opus[1m]",
    "crossWritesAllowed": true
  }
}
```

- **`docsSiteId`** — the id of the **sessions project** whose folder contains `projectsDir` (your vault).
  The brief, concepts and plan run there. Add the vault as a project first, the way every project is
  added — **Projects → Add project** and approve it on the phone, or by hand with the daemon stopped
  ([running-agents.md](running-agents.md), «A project is something you approve»). `mockups` does not
  check the id when it starts: a wrong one shows as the warning on the gallery («there is no sessions
  project …») and as a failed launch.
- **`vault.projectsDir`** — the folder of your projects: each project is `<slug>/<slug>.md`, a hub whose
  frontmatter has `work-dir:` (absolute or `~/…`). A project without `work-dir` is listed and cannot be
  chosen. Each mockup gets `<slug>/mockup/` (or `mockup-2/`…) for its documents.
- **`vault.mapFile`** — optional. When you create a NEW project from the screen, its line goes at the end
  of the map's `## Active projects` and `"[[<slug>]]"` into its `related:` (an array on one line). If the
  file has no such section, the project is created anyway and the screen says «map not updated».
- **`workRoot`** — where a new project's work folder is made (`<workRoot>/<PascalName>/`).
- **`model`** — optional, passed to `sessions` as is. It is **not checked** against the models `sessions`
  knows: a wrong name fails when a stage launches, with `sessions`' error on the stage.
- **`crossWritesAllowed`** — see below. `false` by default.

Paths are absolute or start with `~/`. A bad block switches off `mockups` only, with the reason in the
log and in `/modules`; the rest of the daemon runs. No rebuild: restart the daemon.

The state is `~/.factotum/<env>/modules/mockups/mockups.json` (mode 0600). A file that does not pass its
schema is copied to `mockups.json.bad-<date>` and the module stays off until you fix or remove it.

## 2. Prerequisites — check each one

- **Stage sessions write outside their own project.** The plan runs in the vault and writes
  `directions/` in the work folder; deliver and redeploy run in the work folder and write in the vault.
  `sessions` lets a session write outside its project only inside a **shared** path, or anywhere with
  `allowOutside: true` in the sessions config. Either make `workRoot` and `projectsDir` shared paths of
  `sessions` (`sharedPaths` in its config), or turn `allowOutside` on and set `crossWritesAllowed: true` here (the screen cannot see
  `allowOutside`, so you tell it). Otherwise the gallery shows «stage sessions will ask before writing
  outside their project», and they will — by push, one write at a time.
- **The work folder must be a sessions project** for build, deliver and changes. If it already is one
  (or sits inside one), the mockup uses it. If not, the screen asks `sessions` to add it, and you approve
  on the phone; a refusal or an expired request leaves «Request again». Brief, concepts and plan do not
  need it.
- **`vercel` logged in**, on that host, as the user the daemon runs as (`vercel whoami`). **Without a
  login `vercel` does not fail: it starts a device login and waits.** A stage that meets it loses several
  minutes, says so, ends without submitting and shows «stalled»; log in and press **Retry**. Each
  mockup uses two Vercel projects, `<slug>-directions` and `<slug>-mockup`, created by the stages.
- **`textutil`** (`/usr/bin/textutil`, macOS) reads Word files. PDFs are read by the agent; a scanned PDF
  is read as images.
- **The Mac must stay awake.** A build takes ten to twenty minutes. Nothing in factotum keeps the Mac
  awake: if it sleeps, the session stops, and the stage ends «stalled» → **Retry**. Run the daemon under
  `caffeinate -i`, or keep something that holds the Mac awake while you work.

## 3. Real client data

Upload real samples with **Real client data**: they go to `inputs/private/` and are marked on the
screen. Only the plan may open them, and only to learn their shape so the invented data looks real.
Every other stage is told not to open them.

Before anything is public, and again when a stage hands in, the module compares the hash of every file
in `inputs/private/` with every file in `directions/` and `mockup-app/` (skipping `node_modules`, `.next`,
`.vercel`). A copy is refused; so is a tree it cannot finish checking (20 000 files or 60 s).

**What it does not catch:** a sample paraphrased, an extract, a value retyped, a copy re-encoded (a CSV
saved as JSON). The plan's gate is where you catch those — read `04-data.md` before choosing.

**A change request is the easiest way around it.** Its text goes to the stage literally (framed as data,
not instructions). If you paste a client's email that says «use our real numbers», the session may
retype them, and the check will not see it. Write the request yourself.

**The order of publishing is in the prompt, not enforced.** A preview deploys with Vercel's protection
on, is checked, and only then opened; production is checked BEFORE it deploys (the production URL is
public even with the protection on). The module never runs `vercel` itself: a session that skips the
check can publish first.

## 4. Every URL is public

Directions, previews and production are open to anyone with the link — the owner chose no protection,
so the gates open on the phone without a Vercel login, and a password is a paid feature anyway. Send the
production URL to the client yourself; the module sends nothing.

**Deleting does not unpublish at once.** `vercel project remove <project>` makes the production URL
answer 404 right away, but a preview URL went on answering 200 from Vercel's edge cache for minutes.

**The token file.** `vercel link` writes a `.env.local` with a token into the folder it links. The prompt
has the stage list `.env*` and `.vercel` in that folder's `.vercelignore`, and the check refuses a `.env*`
file in `directions/` or `mockup-app/` that the `.vercelignore` does not cover.

**The protection is one switch for the whole project.** A stage turns it on before a preview and off
after the check; a stage that dies in between leaves it on (previews ask for a login) or, after, off.

**What the module cannot see:**
- *which folder was deployed.* The checks look at `directions/` and `mockup-app/`; a stage that ran
  `vercel deploy` from the work folder itself would upload `inputs/`, and nothing would notice;
- *whose deployment a URL is.* A URL is accepted when its host is `<project>.vercel.app` or starts with
  `<project>-`, the stage's own project. Any Vercel account can name a project so; and for a project name
  longer than 20 characters only its first 20 are compared, which can match the other project of the
  same mockup. Open what the gate shows before you send it to anyone.

## 5. Using it

1. **New mockup** — on an existing project of the vault, or a new one (title, client, one sentence,
   difficulty, due date): the module writes its hub, its work folder and its line in the map.
2. **Inputs** — upload files (up to 50 MiB each), mark real data, write or dictate notes. They are closed
   while a stage runs.
3. **Start brief.** The session's title is `Mockup · <stage> · <name>`; **Open session** jumps to it.
4. At each gate: **Approve** / **Choose**, or **Redo with this comment** — the current version is copied
   to `_versions/` first (for the app, the previous preview stays live at its URL).
5. After delivery, **Changes**: write or dictate what the client asked; review its preview; approve to
   send it to production.

**Stalled** means the session ended without handing in: answer it in the session to carry on, or
**Retry**. A run that never got its session offers **Abandon** after two minutes.

**Handing a stage session to the other host** (ADR-0020) leaves it without `submit_stage`: it ends
stalled; retry it here.

## 6. What goes where

- **The push** says only `<mockup name>: <stage> ready` and «Tap to review.» — never the summary, a
  document or a change request. The name is yours: if the client's is sensitive, name it otherwise.
- **The module's log** carries ids, stages, runs and states, never content. The `sessions` titler logs
  the title it makes from a prompt, and for a change that title summarises the client's request.
- **The inputs** stay in the work folder; only their names are in `mockups.json`.
- **To Claude** goes what each stage's session reads: the inputs (and, in the plan, the private ones),
  the documents, the code.

## 7. The routes

Under `/modules/mockups/`, `GET` and `POST` only, every answer `no-store`; `503 starting` until the module
has started. Errors are `{ error: { code, message } }`, and a `400` names the field.

| Route | What |
|---|---|
| `GET mockups` | the gallery (not archived) and the setup the screen needs |
| `GET projects` | the vault's projects, with their work folder |
| `POST mockups` | create: `{ name, client, project: { kind: "existing", slug } }`, or `project: { kind: "new", slug, title, client, summary, difficulty: "low"\|"medium"\|"high", due?: "YYYY-MM-DD" }` |
| `GET mockups/:id` | one mockup |
| `POST mockups/:id/site-match` · `POST mockups/:id/site` | its work folder as a sessions project |
| `POST mockups/:id/inputs?name=<file>[&private=1]` | upload one file (the raw bytes) |
| `POST mockups/:id/notes` | `{ text }` |
| `GET mockups/:id/docs/:stage` | the stage's documents, frontmatter apart |
| `POST mockups/:id/runs` | `{ kind }`, or `{ kind: "change" \| "redeploy", changeId }` → the run to launch |
| `POST mockups/:id/decision` | `{ step, action: "approve" \| "choose" \| "redo", optionId?, comment? }`; `step` is a stage or `{ changeId }` |
| `POST mockups/:id/changes` | `{ text }` → the change and its run |
| `POST mockups/:id/archive` | out of the gallery |
| `POST runs/:runId/session` · `/stall` · `/abandon` | link a run to its session; mark it stalled; abandon it |

The screen launches the sessions itself (a module cannot launch one): a run's answer carries the
prompt, site and title, and the screen posts them to `sessions` with `force: true`. Paths come back
real (`/private/tmp/…` for `/tmp/…` on macOS).

## 8. Turning it off

Remove `modules.mockups` (or set `enabled: false`) and restart. `mockups.json`, the documents and the
work folders stay where they are.
