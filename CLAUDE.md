# Working in this repo

This does **not** explain what factotum is or why it is built this way — that is
[`README.md`](README.md), [`docs/`](docs/) and the ADRs.

This is **the rules that get broken by accident**: the ones you do not deduce from
skimming the code, and that you need *before* you write. Every one of them comes from
having broken it, and every one is anchored to a real file.

**Line numbers rot.** The symbol name is next to each one for exactly that reason: if
the number does not match, search for the name and fix the number as you pass.

---

## 0. The rule that saves the most time: verify, do not remember

**No claim about this code counts until you have opened the file.**

That is not a platitude here, it is a measured result. The spec that produced this
repository went through three audits and needed four revisions. Nine blockers. And the
same failure caused most of them:

| Revision | What went wrong |
|---|---|
| v1 | Three claims about the predecessor project, written **without opening the file** |
| v2 | Fixed those, and **broke another in the opposite direction** — claimed the predecessor solves something it does not |
| v3 | Measurements finally right; the corrections survived **only in the main text** while stale copies lived on in two tables |

All three times, on the network surface. Two habits came out of it, and both are now
enforced by the documents themselves:

- **Secondary tables reference a decision; they never restate it.** A rule written in
  two places drifts, and the copy a reader reaches first is the one that wins.
- **A scripted find-and-replace that does not find its text fails silently.** That is
  how one paragraph survived three revisions with wording everyone believed had been
  changed twice. Close with `grep`, not with faith.

When the claim is about data, measure it. Counting the imports in a file costs one
command and settles an argument that would otherwise go three rounds.

---

## 1. The contract: where everything lives

| What | Where | Why |
|---|---|---|
| The module contract | `packages/core/src/module.ts` | What a module *is*. Five fields |
| Anything crossing HTTP, and the config | `packages/core/src/http.ts`, `config.ts` | Validated at the boundary |
| The daemon | `packages/kernel/` | **Knows no module by name** |
| The modules, and yours | `modules/` | `index.ts` bundled, `local.ts` yours |
| The binary | `packages/cli/` | **The composition root** |

**Three dependency rules, and they are the design:**

```
packages/kernel  →  modules/          NEVER. Not in package.json, not by import
packages/cli     →  modules/          yes — it is the composition root
modules/*        →  packages/core     yes, and only to core
```

`boot()` **receives** the module list. If you ever find yourself importing a module
inside the kernel to fix something, the contract is wrong and the contract is what you
fix. There is a test for this, and a `grep` in the spec's criterion 6.

### The absences in `ModuleContext` are load-bearing

A module is not given the server, the port, the address, the root config, another
module's config, or the registry. **That is not minimalism, it is the mechanism**: a
module that cannot reach the socket cannot decide the network surface, and the whole
security model depends on that being one decision in one place.

Before you add a field to `ModuleContext`, find the consumer that needs it **today**.
Two things are known not to fit and are deliberately left out — notifications, and
binary request/response bodies. Both are written down in the spec's design §9.

---

## 2. Traps that have already bitten, in this repo

### Zod strips unknown keys, and it bites twice

`moduleEntrySchema` carries `.catchall(z.unknown())` (`packages/core/src/config.ts:57`).
**Do not remove it.** The root schema knows nothing about any module's fields, so
without it, validating the config would empty every module's fragment before its owner
saw it. In the predecessor project the same trap silently deleted fields from disk
whenever a parsed object was written back.

**And it repeats one level down.** A module's own `configSchema` also drops unknown
keys. Harmless while the module only reads. The moment one re-reads and writes its
fragment back, every key its schema does not know is gone from disk.

### `::ffff:0.0.0.0` is a wide bind whose sixteen bytes are not zero

Bytes 10 and 11 are `0xff`. `isWideBind` (`packages/kernel/src/net/ranges.ts:145`)
**normalises first and checks after** for exactly this. A naive byte check misses it,
and a string comparison against `'0.0.0.0'` misses `::`, `::0`, `0:0:0:0:0:0:0:0` and
this one — which is the hole in the predecessor's own refusal, the check this project
cites approvingly.

### `FactotumModule<C>` is invariant in `C`

`ModuleContext<C>` is an *argument* of `routes` and `start`, so
`FactotumModule<Specific>` is not assignable to `FactotumModule<unknown>` and a
heterogeneous list does not type. TypeScript has no existential types; the workaround
is `AnyModule` (`packages/core/src/module.ts:137`) and it uses `any` on purpose. The
safety is not lost, only moved: `composeModules` parses each fragment with the only
schema that knows its shape.

### `exactOptionalPropertyTypes` is on

`nav?: NavEntry` will not accept an explicit `undefined`. When a value may genuinely be
absent and you are assigning it, write `nav: NavEntry | undefined`. Internal types do
this; the public ones keep the cleaner `?` and build the object conditionally.

### Source imports carry `.ts`

`rewriteRelativeImportExtensions` turns them into `.js` on the way out. That is what
lets the same file be run by Node and compiled by `tsc`. Do not "fix" an import to
`.js`.

---

## 3. The boot order is the design, not a sequence

`packages/kernel/src/boot.ts` — thirteen steps. Two are not where you would put them,
and both were moved after an audit:

- **`start()` is step 12, after the bind is verified.** Put it earlier and a module has
  already written to disk and called its provider before anyone knew where the process
  was listening.
- **READY is step 13.** Between `listen` and READY the API answers `503`
  (`boot.ts:103`). Without it the server would dispatch to a module whose `start` had
  not run, and would have been serving on whatever the socket actually bound to while
  step 11 was still deciding.

**The static site and `GET /health` are served from step 9**, before READY. A QR scanned
during a restart must get HTML, not a bare 503, and a supervisor needs to tell
"starting" from "wedged".

---

## 4. The security surface: four things you must not weaken

There is no credential. That decision only holds because of these, and each has a test:

1. **The address is declared in the config, never guessed at startup.** Auto-detection
   lives in `factotum init` and nowhere else.
2. **Every spelling of a wide bind is refused, with no flag.** See above.
3. **After `listen`, the socket is asked what it actually bound to**, and the process
   closes if that disagrees. Steps 4 and 5 validate the intention; step 11 is the only
   thing that checks the outcome.
4. **`Origin` is checked by shape: same host, same port**
   (`packages/kernel/src/net/origin.ts:58`).

### On the origin policy specifically

**This was got wrong three times before it was got right.** If you touch it, read the
tests first — they encode the failures:

- A list derived from `listen` gives **403 on MagicDNS**, which is a normal way in.
- Accepting any private-range address lets in `192.168.1.1` (another machine) and
  `localhost:3000` (another service). **Requiring the port is what does the work**, and
  it is also what currently blocks Tailscale Funnel.
- `endsWith` instead of exact hostname equality admits
  `http://127.0.0.1.attacker.com`, a name the attacker owns.
- `localhost` is accepted **only when the bind is loopback**. The predecessor accepts it
  unconditionally, but it opens a second listener there; this does not, so the policy
  follows the bind rather than copying the precedent.

`Host` is **not** checked, so DNS rebinding is not covered. That is declared in
`docs/networking.md`, not forgotten.

---

## 5. Config errors degrade, programming errors abort

`packages/kernel/src/errors.ts:38` states the rule and
`composeModules` (`packages/kernel/src/config/load.ts:90`) applies it:

> **Abort** anything that compromises the **network surface** or the **identity of the
> process** — where it listens, which environment it thinks it is, two modules claiming
> one id.
> **Degrade** anything confined to a **single module**.

The daemon refuses to exist *wrongly*; it does not refuse to exist *incompletely*. A
mistyped credential path for one module must not cost its owner everything.

**`boot` never calls `process.exit`.** It throws `BootError`; `packages/cli` decides
the code. That is what keeps every abort path testable in-process instead of needing a
subprocess to read a status.

**Every `BootError` carries a remedy.** "It refuses to start and I do not know why" is
the standard complaint about software that fails closed correctly, so the remedy is
part of the type rather than something a call site can forget.

---

## 6. Two ownership rules that look like details

**The kernel owns every timer it hands out** (`registry.ts:63`). It tracks them per
module, `unref`s them, and disposes them even when `start` throws after arming one.
Without that, a module that creates an interval and then fails leaves it running with
no handle to call, and the process never exits on SIGINT. **Modules must use
`ctx.timers`, never the global `setInterval`** — and a test can advance those.

**The kernel serves the 501 for a disabled module.** A module disabled by bad config
has no context, so there is nothing to ask for a route table; the stub is the only way
it can work. A module disabled at step 12 had already mounted real routes, and the
registry swaps them.

---

## 7. Testing conventions

- **Doubles, not real modules.** The server and registry tests build modules inline.
  Importing a real one into a kernel test breaks the dependency rule and the criterion-6
  `grep`.
- **Inject the world.** `statePaths(env, home)`, `resolveListen(listen, interfaces)`,
  `ctx.timers`, `ctx.now` — all take their dependency so a test never writes to the real
  `~` or depends on the machine it runs on.
- **Real sockets on loopback with a fixed unique port.** `listen.port` has a floor of
  1024 in the schema, so `0` is correctly refused; `boot.test.ts` allocates from a
  counter.
- **Poll, do not guess a delay.** The example module persists its tick with a
  fire-and-forget write, so a test cannot assume it has landed by the next microtask.
  There is an `eventually()` helper; a `setImmediate` looked deterministic right up
  until coverage instrumentation shifted the timing.
- **Prove the guard in red.** A module that violates the contract should fail to
  compile — write it, watch it fail, delete it.

---

## 8. Where the reasoning lives

The **ADRs** are in [`docs/adr/`](docs/adr/) and travel with the repo: the static
registry, the no-credential bind, the Claude CLI over the Agent SDK, and
degrade-versus-abort.

The **full specs** (requirements, design, tasks, summary) live in the author's Obsidian
vault and are not in this repository. If you are reading this as a contributor, the
ADRs plus `docs/` are meant to be enough — and if they are not, that is a bug worth an
issue.
