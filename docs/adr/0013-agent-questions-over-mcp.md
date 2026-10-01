# 13. The agent asks the owner through an MCP tool the sessions module serves

**Status:** accepted

## Context

An agent that needs a decision asks in prose, and the owner answers by typing with a thumb and
rebuilding which answer goes to which question. The agent then interprets the reply; when it gets
it wrong, that is found out after it has written files. A menu turns an interpretation into a
datum. The predecessor (Jarvis) solved this with an MCP tool and a held call, and needed one thing
here would cost: **a heartbeat**. With CLI 2.1.231 a held MCP call died after ~295 s of silence
whatever the server's `timeout` said; only bytes on the wire kept it alive. A module cannot send
loose bytes — `ModuleResponse` is answered whole, and ADR-0012 says *never a stream* — so the
heartbeat would have meant a kernel change.

**That ceiling moved.** In CLI 2.1.286 the idle limit is computed as

```js
idle = CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT ?? (stdio ? 1_800_000 : 300_000)
limit = min(max(idle, server.timeout >= 1000 ? server.timeout : 0, 1000), wallClock(server))
```

so a server's `timeout` lifts the wall clock **and** the idle ceiling. Measured, not read: a call
held 420 s without a byte arrived over HTTP and over stdio, and one held **2 400 s** arrived over
HTTP with `success`.

## Decision

- **One tool, `ask_owner`, served by the sessions module** on `POST /modules/sessions/mcp/:sessionId`.
  Three JSON-RPC messages (`initialize`, `tools/list`, `tools/call`), no SDK. The session is in the
  URL: the messages carry none. The route answers like the hook — reachable from loopback, held — and
  only opens batches of **its** session; answering needs a token that lives in memory and in the
  encrypted push (ADR-0009, ADR-0010), exactly like an ask.
- **Every session is launched with `--mcp-config`**, a file per session next to `settings.json`:
  `type: "http"`, the module's URL, **`timeout` = `HOOK_TIMEOUT_SECONDS * 1000`** (derived, the same
  knob as the hook), and `alwaysLoad: true` — without it the CLI defers the tool behind `ToolSearch`
  and the agent spends a turn finding it.
- **Never `--strict-mcp-config`.** The owner's own MCP servers reach a session through
  `--setting-sources user`; the strict flag would drop them all, silently. The titler keeps it: it
  must have no tools.
- **The module only translates.** It cannot import the engine's package (CLAUDE.md §1), so the
  protocol, the session check and the batch table live in `packages/sessions`, behind three facade
  members (`mcp`, `inspectQuestions`, `answerQuestions`). The one piece of JSON-RPC the module knows
  is how to answer a failure the agent can read.
- **The log gains a sixth kind, `questions`** (`asked`, `settled`), written by the daemon. The tool's
  own call and result are dropped from the stream: the event is the record. Whoever closes a batch —
  an answer, the window, Cancel, a process that ends, `stop()` — writes its `settled`, and before the
  session's terminal state.

## Consequences

- **One more argument to the CLI.** Two earlier specs promised `buildArgs` untouched; this one does
  not, and the exact-argv test was edited to include it rather than loosened.
- **It depends on the CLI keeping the two ceilings together.** If a future CLI separates them again,
  a held question dies at five minutes with nothing here touched. The fix is a heartbeat, and that
  **does** touch the kernel: its own spec and its own ADR. The comment in `questions/config.ts` says
  where to look.
- **The window is the permission ask's** (3 570 s). Expiring does not end the session: the agent is
  told nobody chose and to end its turn — measured with Haiku, Sonnet and Opus, none went on — and
  the conversation is resumed by writing.
- **No push, no questions.** Without a device to reach, the tool answers at once that the owner cannot
  be reached, and the agent asks in prose, as before. The same rule as the gate.
- **The engine's types are declared twice again** (the tenth to sixteenth such types). This is still
  one consumer, the sessions module, so ADR-0005's "third consumer" signal has not fired; it is noted
  here so the count is not lost.

## What this does not do

- A contract for other modules to serve MCP tools. One tool, in one module; the second consumer
  decides the shape.
- Heartbeat, SSE or stdio.
- Changing an answer once sent, or retrying an expired batch.
