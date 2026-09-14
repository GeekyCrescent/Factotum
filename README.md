# factotum

A modular remote client for Claude Code. Your agents run on **your** machines; you
reach them from your phone.

A *factotum* is a servant who does everything. The kernel here knows how to do
nothing at all — what it can do arrives as **modules**, and you switch on the ones
you want.

> **Status: it launches agents.** You can clone this, run it, declare a directory you
> are willing to let an agent write in, and launch Claude Code in it from your phone —
> watching its messages arrive, replying, and cancelling. The client is deliberately
> plain; its design is a separate piece of work.

---

## What you need

- **Node ≥ 22** and **pnpm**
- **[Tailscale](https://tailscale.com/download)** on this machine and on your phone,
  in the same tailnet
- **[Claude Code](https://claude.com/claude-code)** on your `PATH`, signed in — this
  is the engine; factotum is the door

## Five minutes

```sh
git clone https://github.com/GeekyCrescent/Factotum
cd Factotum
pnpm install
pnpm build

factotum init      # or: node packages/cli/dist/main.js init
factotum start
```

`init` finds your Tailscale address, writes `~/.factotum/prod/config.json`, and prints
a **QR code**. Scan it with your phone. That is the whole setup — you never type an IP.

If something is not right, `factotum doctor` reports what it can see without starting
anything.

## There is no password, and that is a decision

factotum listens **only on a private network address** — your Tailscale address, or a
LAN one. It has no login, no token, no TLS. Being on the tailnet is the authorisation.

That is defensible for one person on their own machines, and it is why:

- **It refuses to listen on `0.0.0.0`.** There is no flag for it. If you genuinely
  want to expose it, put a proxy in front — that should be a visible decision of
  yours, not a switch of ours.
- **It refuses to start** if it cannot confirm where it is listening, rather than
  falling back to something that works but is wrong.
- **It checks `Origin`.** The bind decides where you can reach it *from*; it says
  nothing about who is talking once inside. Any page you open in a browser on your
  tailnet could otherwise POST to it. See [docs/networking.md](docs/networking.md).

**What this does not protect against:** anyone else on your tailnet. If you share it,
they can do everything you can. Read [docs/networking.md](docs/networking.md) before
you run this anywhere unusual.

> **And since it launches agents, that sentence got sharper.** Before, the worst
> somebody else on your tailnet could do was read a `ping`. Now they can **launch
> agents in your sites**, which is running code as you, on your machine. There is no
> password in front of that. If your tailnet has anyone else on it, read
> [docs/running-agents.md](docs/running-agents.md) first.

## Modules

The kernel has no idea what a shopping list or a calendar is. Modules do, and each
one is five things: a config fragment, some HTTP routes, a nav entry, a screen, and
optional background work.

Switch one on or off in `~/.factotum/<env>/config.json` — **no rebuild**:

```json
{
  "modules": {
    "example": { "enabled": true, "greeting": "hello", "tickSeconds": 30 }
  }
}
```

Write your own by copying `modules/example/` and adding a line to `modules/local.ts`.
[docs/writing-a-module.md](docs/writing-a-module.md) is the guide.

> **A module is not sandboxed.** It runs in the same process with full Node
> privileges: it can read your files and open sockets. Installing someone else's
> module is exactly as risky as installing any npm dependency. The contract buys
> design discipline, not containment.

## Sessions

The module that launches agents. You declare **sites** — directories you are willing
to let an agent write in — and a **catalog** of things to launch:

```json
{
  "modules": {
    "sessions": {
      "enabled": true,
      "sites": [{ "id": "notes", "path": "/Users/you/notes" }],
      "catalog": [{ "id": "free", "label": "Free prompt", "invoke": { "kind": "none" } }]
    }
  }
}
```

A write whose destination lands inside the site is allowed; outside it is denied, with
the reason in the log and on the screen. Reading is never asked about. Sessions
persist to an append-only log, so you can close the tab and come back.

**`Bash` is not checked against that boundary, and this is not containment.**
[docs/running-agents.md](docs/running-agents.md) lists all ten limits, and it is worth
reading before you declare your first site.

## Two environments

`dev` and `prod` are separate configs, separate state and separate ports, and they
run side by side on one machine — which is the point, because comparing two sets of
modules is easier than remembering what you changed.

```sh
factotum init --env dev
factotum start --env dev     # 7778 by default, while prod keeps 7777
```

State lives in `~/.factotum/<env>/`. Nothing about one environment touches the other.

## Layout

```
packages/core     types and schemas — the module contract. No I/O
packages/kernel   config, bind, origin policy, registry, HTTP. Knows no module
packages/sessions the session engine: subprocess, event log, locks, permissions.
                  Knows nothing about HTTP, and no module depends on it
packages/cli      the `factotum` binary — and the composition root
modules/          the bundled modules, plus local.ts where yours go
apps/web          the client shell: navigation and module mounting
docs/adr/         why things are the way they are
```

The kernel never depends on `modules/`; the CLI passes the list in. That is what keeps
the kernel free of special cases, and it is checked by a test.

## How this repo is meant to be worked on

[`CLAUDE.md`](CLAUDE.md) is the rules that get broken by accident — the traps that have
already bitten, why the boot order is what it is, and the four things holding up the
no-credential decision. Read it before changing anything in `packages/kernel`.

## Working on it

```sh
pnpm build        # types, then the client bundle
pnpm typecheck
pnpm test         # unit + integration, with an 80% coverage gate on the kernel
```

`pnpm install` will ask you to approve one build script (`esbuild`, which unpacks a
platform binary for the bundler). That approval is already recorded in
`pnpm-workspace.yaml`.

## Licence

MIT. See [LICENSE](LICENSE).
