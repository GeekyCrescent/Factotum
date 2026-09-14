# Writing a module

A module is five things. You rarely need all five.

| | What it is | Without it |
|---|---|---|
| `configSchema` | Your fragment of `config.json` | You get no configuration |
| `routes` | HTTP handlers | You have no API |
| `nav` | Label and icon | You have no screen |
| `start` | Background work | Nothing runs on a timer |
| `client.tsx` | The screen itself | Nav points at nothing |

The shortest way in is to copy `modules/example/`. It is deliberately useless and
deliberately complete — it exercises all five so that none of them is untested.

## Ten minutes

**1. Make the folder.**

```sh
cp -r modules/example modules/shopping
```

**2. Rename the id.** In `server.ts`, `id: 'shopping'`. That one string names four
things: your config block (`modules.shopping`), your route prefix
(`/modules/shopping/`), your state directory, and your client path (`/m/shopping`).
It must match `^[a-z][a-z0-9-]*$` — it is a directory name and a URL segment, so it
cannot contain `/` or `..`.

**3. Register it** in `modules/local.ts`:

```ts
import { shoppingModule } from './shopping/server.ts'

export const LOCAL: readonly AnyModule[] = [shoppingModule]
```

And its screen in `apps/web/src/modules.ts`.

**4. Switch it on** in `~/.factotum/prod/config.json`:

```json
{ "modules": { "shopping": { "enabled": true } } }
```

**5.** `pnpm build && factotum start`.

---

## What you are given

```ts
start: async (ctx) => { … }
routes: (ctx) => ({ … })
```

`ctx` has exactly five things:

- **`ctx.config`** — your fragment, already parsed by *your* schema. Never `unknown`.
- **`ctx.stateDir`** — `~/.factotum/<env>/modules/<id>/`, created before you exist.
  Write here. You *can* write elsewhere, and that is the single fastest way to make
  your module useless on someone else's machine.
- **`ctx.env`** — `'dev'` or `'prod'`.
- **`ctx.log`** — prefixed with your id, writing to stderr so it does not interleave
  with anything on stdout.
- **`ctx.now()`** and **`ctx.timers`** — see below.

### What you are not given, and why

You do not get the server, the port or the address. The network surface is one
decision made in one place, and a module that could listen would be making its own.

You do not get the root config, other modules' config, or the registry. **Modules
cannot talk to each other.** If yours needs another one, today the answer is that
they are one module split badly — and if that turns out to be wrong, it is
[open question 2](adr/) and it will be decided with your case in hand.

None of this is a sandbox. You can `import fs` and read whatever the user can. The
contract stops well-meaning mistakes, not malice.

## Routes

```ts
routes: (ctx) => ({
  'GET /items': async () => ({ status: 200, body: await list(ctx) }),
  'GET /items/:id': async (req) => ({ status: 200, body: await one(req.params.id) }),
  'POST /items': async (req) => ({ status: 201, body: await add(req.body) }),
})
```

- The path is **relative**: the kernel serves it at `/modules/<id>/items`.
- **`req.params` is already URL-decoded.** Ids in a path are real things — an email
  address, a name with a space — and you would remember to decode them exactly once.
- **`req.body` is parsed JSON**, capped at 1 MB by the kernel. Binary bodies do not
  fit this contract yet: you cannot upload or serve a file. That is a known gap.
- **Literal segments beat parameters.** `GET /items/new` wins over `GET /items/:id`
  no matter which order you wrote them in.
- **Two parameters with the same name abort startup.** Name them
  `:calendarId` and `:eventId`, not `:id` twice.
- If you throw, the client gets a generic 500. **Your exception message is not
  forwarded** — it could carry a path or a credential. Return a `ModuleResponse` for
  anything you want the user to read.

## Background work

```ts
start: async (ctx) => {
  const timer = ctx.timers.setInterval(() => void sweep(ctx), 15 * 60_000)
  return { stop: () => timer[Symbol.dispose]() }
}
```

- **Use `ctx.timers`, never the global `setInterval`.** The kernel owns what it gives
  you: it `unref`s them, so your work never keeps the process alive by itself, and it
  disposes them even if your `start` throws after arming one. A test can also advance
  them, which a global timer would make impossible without really waiting.
- `start` runs **after** the daemon has proven where it is listening, and it is
  **bounded**. If it hangs for more than ten seconds your module is disabled — the
  daemon must not sit at "starting" forever because one provider is down.
- If `start` throws, your module is **disabled with the reason** and everything else
  keeps running. Config errors degrade; they do not take the daemon down.

## Configuration

```ts
export const shoppingConfigSchema = z.object({
  apiKeyPath: z.string().optional(),
  sweepMinutes: z.number().int().min(1).max(1440).default(15),
})
```

- **Give every field a default.** A module that cannot start without being configured
  is badly designed. Its default is "off", and turning it on should be one key.
- **Secrets are a PATH to a file outside the repository**, never a value. Read the
  file yourself, in `start`, and fail with a clear message if it is not there — you
  will be disabled with that message, which is exactly right.
- **If your module ever WRITES its own config back, add `.catchall(z.unknown())` to
  your schema.** Zod drops unknown keys. Parsing and writing back therefore deletes
  every key your schema does not know, from disk, silently. This has bitten this
  project's predecessor. Reading only? Then it cannot happen and you can ignore this.

## Testing

Your module is plain functions and a context object. There is nothing to stand up:

```ts
const ctx = {
  config: shoppingConfigSchema.parse({}),
  stateDir: await mkdtemp(join(tmpdir(), 'test-')),
  env: 'prod',
  log: { info: () => {}, warn: () => {}, error: () => {} },
  now: () => new Date('2026-01-01'),
  timers: fakeTimers(),
}

const response = await module.routes!(ctx)['GET /items']!(request)
```

`modules/example/server.test.ts` has a `fakeTimers` you can copy, and shows how to
test a background task without waiting for it.

---

## Three lessons from the sessions module

That module is the first one large enough to hurt, and it produced three rules that
apply to whatever you write next.

### 1. `routes()` may not throw anything but a `BootError`

Step 8 of boot — where the kernel asks your module for its route table — has **no
`try/catch` above it anywhere**. This was not reasoned about, it was executed: a plain
`Error` from `routes()` takes the whole daemon down with a raw stack, while the same
error from `start()` disables only your module and leaves a reason a person can read.

So `routes()` composes functions and nothing else. Anything that can fail belongs in
one of the two places that are protected:

| Where | What belongs there | Why |
|---|---|---|
| `configSchema`, step 6 | Shape. Is the path absolute, is the number in range | It runs synchronously, so it **cannot touch the disk** |
| `start()`, step 12 | Everything that does I/O, everything that can fail | It runs inside the registry's `try/catch`, after the bind is verified |

And **your schema itself may not throw.** The kernel uses `safeParse`, which catches a
validation *failure* but not an exception raised by the schema. No `.transform` that
can throw, no async refinement.

### 2. A capability you receive travels complete

If your module needs something the contract does not hand it — a function, a client, a
whole engine — take it as a **constructor argument** and have `packages/cli` pass it
in. That is the composition root's job and it already imports everything.

**Pass what it needs in one object.** Splitting it in two — half declared by the
module, half added by the root — is not impossible to type, but the obvious way to do
it does not compile: with `strict` the parameter is contravariant, and a literal with
the extra property is an excess-property error. A complete setup has neither problem.

Declare the shape in your own `types.ts`, importing only `@factotum/core`. You may
**not** import the package that implements it: a module depends on core and only on
core. TypeScript is structural, so the two descriptions meet at one assignment in
`packages/cli`:

```ts
const engineFactory: CreateEngine = createEngine
```

That line is load-bearing. Write the members as **function-typed properties**, never
method syntax:

```ts
// catches an argument that changes shape
readonly launch: (input: LaunchInput) => Promise<LaunchResult>

// does NOT — the parameter is bivariant even under strictFunctionTypes
launch(input: LaunchInput): Promise<LaunchResult>
```

Know what it does not catch: a field **added** to a return type on the other side.
Your module drops it silently. That is survivable — a feature nobody sees — and it
stays survivable only because of the next rule.

### 3. One zod schema per config fragment

Exactly one, and it lives in your module.

Two validators of the same data drift, and zod strips keys it does not know. A field
one side knows about and the other does not **disappears before the consumer sees it**
— not as an error, as a missing value. For the sessions module that data is the
permission boundary, which makes the difference between "a feature nobody sees" and
"a decision taken with incomplete data".

If a component you inject needs the parsed config, hand it the value. Do not hand it
a second schema.
