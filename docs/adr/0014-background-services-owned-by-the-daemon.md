# 14. Background services are owned by the daemon, not the CLI

**Status:** accepted

## Context

An agent asked for a dev server or a long copy runs it with `Bash` and `run_in_background: true`, and
it dies the moment the turn ends. Factotum does not kill it: `runAgent` waits for the process to close,
and nothing on the normal end of a turn signals anything. **The CLI does.** Measured with CLI 2.1.286
in `-p` + `stream-json`: after its `result` the CLI marks its `local_bash` tasks `killed` and reports
them `stopped`, then exits 0 — the port is gone two seconds later. A background subagent it waits for;
a background `Bash` it does not.

Keeping the CLI alive would not help either. Every reply is another process (`claude -p … --resume`),
so a shell that survived one turn would belong to a process the next turn cannot reach: it could not
read its output or stop it.

## Decision

- **The daemon owns the service.** Four tools on the MCP server the sessions module already serves
  (ADR-0013): `start_service`, `service_output`, `stop_service`, `list_services`. A service is a child
  of the daemon in **its own process group**, killed as a group, in the owner's login shell
  (`$SHELL -l -i -c`: measured under launchd with prod's `PATH`, only the interactive shell finds
  `pnpm`). Its output goes to a file inside the session's directory, rotated at 1 MiB, never to the log.
- **The gate redirects.** `Bash` with `run_in_background: true` is denied with a reason that names
  `start_service` — measured with Haiku, Sonnet and Opus before it was written down: all three called
  the tool on the first try, and none reached for `nohup`. A subagent with its own tool list has no MCP
  tools, so the reason also tells it to hand the command back. The deny is **quiet**: the redirect is not
  a boundary hit, and neither it nor the denied call enter the log.
- **A seventh event kind, `service`** (`started`, `ended`), written by the daemon. One place writes
  `ended`, once, **when factotum decides** — a natural exit, Stop, the 8 h default limit, Cancel, a
  delete, `stop()` — and queues it before signalling, so a Cancel's `ended` lands before the session's
  `cancelled`. `start` reserves its entry before its first `await`, so a Cancel in the middle of a start
  never leaves a `running` row without a process.
- **It survives the turn and nothing else.** A service lives through replies and takes no lock. Cancel
  and delete stop the session's services; `stop()` sends SIGTERM and leaves `services.json` alone, and
  the next start SIGKILLs every group still listed and marks it *stopped by restart*. No readoption.
- **The owner's routes** (`GET …/services/:id/output`, `POST …/services/:id/stop`) need no running turn.
  **The agent's tools only work while its turn runs.**

## Consequences

- **The MCP route has no caller authentication**, and now it can start a process. Like the hook and
  `launch`, it trusts whoever reaches the daemon's loopback or the tailnet with a session id; bounding the
  tools to a running turn narrows the window to when the agent can really be calling, but does not close
  it. Authenticating the MCP route is its own spec.
- **The owner's interactive shell prints its start-up noise** (p10k, `gitstatus`) at the head of every
  output file. Accepted for `pnpm` and the per-project node of the owner's terminal.
- **A service the daemon cannot kill** (a process stuck in `D`) is written as stopped when factotum
  decides, and the next start's reconcile tries again.
- **The engine's types are declared twice again**: `ServiceEvent`, `ServiceView`, `ServiceOutput`,
  `ServiceOutcome` and `StoppedBy` — the seventeenth to twenty-first. Still one consumer, the sessions
  module, so ADR-0005's "third consumer" signal has not fired.

## What this does not do

- Close `nohup … &` in a foreground `Bash`: detecting a background inside a command is parsing shell,
  which the gate already declined (`decide.ts`). Cancel still kills the CLI's group.
- Show or stop the CLI's own `local_bash` tasks; with the redirect there should be none.
- Readopt services after a restart, restart them, or start one from the UI.
- Stream the output (ADR-0012), push when one ends, or a global view of every session's services.
