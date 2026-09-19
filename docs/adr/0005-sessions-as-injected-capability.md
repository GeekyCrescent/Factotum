# 5. The session engine is a package, injected into a thin module

**Status:** accepted

## Context

Launching Claude Code agents is the first thing factotum does that is genuinely
large: a subprocess, an append-only event log, a lock per site, a permission gate, and
three screens. Roughly fourteen hundred lines.

The contract says a module is five things and receives a `ModuleContext` that
deliberately contains no server, no port, no address, no root config and no other
module. The question this piece forced is what happens when a module needs something
the contract does not hand it — here, the URL the permission hook has to call back on.

The predecessor project had already hit the general version of this and its answer was
recorded as the previous spec's open question 2: two of its modules consume each
other. Measuring what it actually does turned out to matter. It does **not** import one
module from another. It declares the capability as a **function type**, and the
composition root passes the function in. `grep` for a cross-module import in it comes
back empty.

## Decision

**The engine lives in `packages/sessions`, a workspace package that knows nothing
about HTTP.** `modules/sessions/` is a shell that puts the five parts of the contract
on the table and delegates.

- `packages/kernel` does not know sessions exist.
- `modules/sessions` does **not** depend on `packages/sessions`. It declares the shape
  it consumes in its own `types.ts`, importing only `@factotum/core`.
- `packages/cli`, the composition root, imports both and joins them:

  ```ts
  const engineFactory: CreateEngine = createEngine
  ```

- Everything the engine needs crosses in ONE object, `EngineSetup`, and nothing is
  added to it from outside. An earlier revision split it in two and handed the second
  half over separately; it did not compile, because with `strict` the parameter is
  contravariant.

Two rules fell out that apply to any module, not just this one:

> **`routes()` may not throw anything but a `BootError`.** Step 8 of boot has no
> `try/catch` above it anywhere. This was checked by executing it: a plain `Error`
> thrown from `routes()` kills the daemon with a raw stack, while the same error from
> `start()` disables just that module and leaves a reason anybody can read.
>
> **What an injected capability needs travels complete.**

## Why not the alternatives

| Option | Why not |
|---|---|
| Put it in the kernel | Breaks the sentence the project is built on — the kernel knows how to do nothing at all — and every `grep` that enforces it |
| Put it all in `modules/sessions/` | Legal, and it fits. But it buries fourteen hundred lines of testable logic inside the module package, and it dodges the question this piece existed to answer |
| Add `ctx.selfUrl` to `ModuleContext` | Opens a sixth part of the contract without the consumer that `module.ts` demands, and makes the network surface something a module can read |

## Consequence — and it is a real cost, not a footnote

**Nine types are declared twice**, once in each `types.ts`, because `packages/core` is
frozen and there is no shared home for them. TypeScript is structural, so the two
declarations meet at exactly one assignment in `packages/cli/src/main.ts`.

**What that assignment catches:** a member renamed or removed, an argument whose type
changes incompatibly, a method that disappears. Both directions were verified by
breaking them on purpose and watching `main.ts` fail to compile.

**What it does not catch:** a field ADDED to a return type on the engine's side. The
module would drop it in silence.

**That asymmetry runs in the safe direction** — what escapes is a feature nobody sees,
never a decision taken with missing data — **and it only runs that way because there
is exactly one zod schema for the config fragment.** With a second schema on the
engine's side, a key the module's schema did not know about would be stripped before
the engine ever saw it (zod drops unknown keys), and that would not be a feature
nobody sees: that would be the permission boundary decided on incomplete data.

The argument members are **function-typed properties and never method syntax**. With
method syntax the parameter is bivariant even under `strictFunctionTypes`, and half of
what the link exists to catch stops being caught.

The right fix the day there is a **second** consumer is a shared home for these types,
which is what the predecessor has. Today that would put one domain's types into the
package that holds the contract, which is what ADR-0001 avoids. **The signal to
revisit is the third consumer, not the second.**

## What this does NOT resolve

The predecessor has **three** cross-module edges, not two: two on the server and one
in its client, where one screen references another's. This decision closes the two
server ones. **The client one is still open**, because there is no sanctioned path for
one module's screen to call another's — `moduleApi(id)` arrives prefixed, and the
client barrel is a static array of instances. That is not a solution, it is the
absence of a consumer, and it is written down as such rather than claimed.

**Note, 2026-09-19 (client design spec):** "nine" above was the count when this was written. Counted
again with `comm -12` over the exported types of both `types.ts`: **19** before that spec, **21**
after it added `AskPreview` and `InspectResult`. The asymmetry and the link in `main.ts` are
unchanged.
