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
