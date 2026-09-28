/**
 * The facade. Everything above talks to this and nothing below knows about HTTP.
 *
 * It is built in `start()` — step 12 of boot — and never in `routes()`. That is not a
 * preference: `registry.ts:163` calls `module.routes(ctx)` with NO try/catch, `boot.ts`
 * does not wrap it either, and `main.ts` only formats a `BootError` and rethrows
 * everything else. Block A ran all three cases to be sure: a plain `Error` from
 * `routes()` takes the daemon down with a raw stack, while the same error from
 * `start()` disables just this module and leaves the daemon up with a reason anybody
 * can read. So every check that touches the disk lives here, below `start()`.
 */

import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Logger, NotificationMessage } from '@factotum/core'
import { findInvokable, resolveCatalog, type Invoke, type ResolvedEntry } from './catalog.ts'
import { checkFreshness, describeFreshness, isFresh } from './freshness.ts'
import { uuidv7 } from './id.ts'
import { CRASH_REASON, ORPHAN_REASON, reconcile as reconcileLocks } from './lifecycle.ts'
import { noticeFor } from './notices.ts'
import { SiteLocks } from './locks.ts'
import { sessionPaths } from './paths.ts'
import { createAskTable, type AnswerResult as TableAnswer } from './permissions/asks.ts'
import { decide as decidePure, resolveTarget } from './permissions/decide.ts'
import { previewOf, type AskPreview } from './permissions/preview.ts'
import { denyBody, preToolUsePayloadSchema } from './permissions/payload.ts'
import { ASK_TIMEOUT_SECONDS, hookSettings, serializeSettings } from './permissions/settings.ts'
import { runAgent, type AgentExit, type AgentRun } from './run.ts'
import { inspectSite, type Site } from './sites.ts'
import { SessionStore, type SessionMeta } from './store.ts'
import type {
  EngineSetup,
  EngineSetupView,
  EventPage,
  HookDecision,
  InspectResult,
  LaunchInput,
  LaunchResult,
  Page,
  SessionEngine,
  SessionPage,
  SessionState,
  SessionSummary,
} from './types.ts'

export const PAGE_SIZE = 25

/** How much of the first prompt a session summary keeps (spec D8d). */
export const PROMPT_CHARS = 140

const STOPPED = 'engine stopped'
const CANCELLED_REASON = 'cancelled by the owner'
const SHUTDOWN_REASON = 'the daemon was shutting down'

/**
 * The reasons a notice may carry, because this package wrote them word for word. A failed turn's
 * reason is the agent's stderr and is NOT here: it can hold paths, and a notice leaves the tailnet.
 */
const NOTICEABLE_REASONS: ReadonlySet<string> = new Set([SHUTDOWN_REASON, CRASH_REASON, ORPHAN_REASON])

/**
 * A seam, and the only one, for exactly the reason the kernel's `makeServer` is one:
 * the alternative is a test that spends quota to prove that a pipe was read.
 */
export interface EngineDeps {
  readonly bin?: string
  /** How long an ask waits for the owner. A seam for the same reason: a test cannot wait an hour. */
  readonly askTimeoutMs?: number
}

interface Live {
  readonly run: AgentRun
  readonly siteId: string
  /** Resolves when the terminal state is on disk and the lock is back. */
  readonly settled: Promise<void>
  /**
   * Set before the group is signalled, and read by the finalizer.
   *
   * WITHOUT IT A CANCELLED SESSION READS "failed: exited with code 143", because that
   * is what a process killed by SIGTERM looks like from the outside and the finalizer
   * has no other way to tell the two apart. Inferring cancellation from the exit code
   * would be guessing at something this process actually knows.
   */
  cancelled: boolean
}

export async function createEngine(setup: EngineSetup, deps: EngineDeps = {}): Promise<SessionEngine> {
  const log: Logger = setup.log
  const paths = sessionPaths(setup.stateDir)
  const store = new SessionStore(paths, setup.now)
  const locks = new SiteLocks(paths)
  await store.ensureRoots()

  // THE I/O THAT DECIDES CRITERION 15 BY ITS SECOND ROUTE. A declared site that is not
  // there throws from here, which is inside `start()`, which is inside the registry's
  // try/catch: the module is disabled with the reason and the daemon stays up. The
  // first route is the schema at step 6, and the two are tested separately because
  // they are genuinely different paths.
  const sites = new Map<string, Site>()
  for (const config of setup.sites) {
    const site = await inspectSite(config)
    sites.set(site.id, site)
  }

  // Inspected exactly like a site — existence, directory, and the symlink spelling —
  // because containment is checked the same way and `/tmp` is a symlink on macOS. The
  // id is not a site id: nothing launches here and nothing locks it.
  const shared: Site[] = []
  for (const path of setup.sharedPaths ?? []) {
    shared.push(await inspectSite({ id: 'shared', path }))
  }

  const catalog: readonly ResolvedEntry[] = resolveCatalog(setup.catalog)
  for (const entry of catalog) {
    if (entry.disabledReason !== undefined) {
      log.warn(`catalog entry "${entry.id}" is disabled: ${entry.disabledReason}`)
    }
  }

  const live = new Map<string, Live>()
  const finalized = new Set<string>()
  let stopped = false
  const asks = createAskTable({
    now: setup.now,
    timers: setup.timers,
    timeoutMs: deps.askTimeoutMs ?? ASK_TIMEOUT_SECONDS * 1000,
  })

  /**
   * Tells the owner a turn ended. FIRE AND FORGET, from all three places that write a terminal
   * state, and never awaited here:
   *
   * - in `finalize`, `cancel()` awaits `settled` and is an HTTP route, so an await here would be
   *   paid by the phone that cancelled (criterion 44);
   * - in `stop`, awaiting would need a bound, and `stop` arms no timer (see its header). The
   *   kernel drains every notice in flight AFTER stopping the modules, each bounded by its own
   *   AbortSignal — that is where the wait belongs (criteria 27, 48, 50).
   *
   * THE .catch IS NOT OPTIONAL. `send` promises not to reject, but it writes subscriptions.json
   * when it removes a dead device, and in Node 22+ an unhandled rejection ends the process
   * (criterion 47).
   */
  function announce(sessionId: string, siteId: string, state: SessionState, reason: string | undefined): void {
    const message = noticeFor(sessionId, siteId, state, reason, NOTICEABLE_REASONS)
    void Promise.resolve()
      .then(() => setup.notify.send(message))
      .catch((error: unknown) => log.warn(`a notice for session ${sessionId} could not be sent: ${error instanceof Error ? error.name : 'error'}`))
  }

  // --- the pieces launch and reply share ----------------------------------

  async function writeSettings(sessionId: string): Promise<string> {
    await store.ensureDir(sessionId)
    const path = store.settingsFile(sessionId)
    // `hookUrl()` throws while the composition root has not filled the thunk in. That
    // is on purpose and it is the last thing that can go wrong before a subprocess
    // exists: a session launched with an unreachable hook is a session with no gate.
    await writeFile(path, serializeSettings(hookSettings(setup.hookUrl())), 'utf8')
    return path
  }

  /**
   * Terminal state, in the order design D9 requires: the meta FIRST, the lock LAST.
   *
   * Dying between the two leaves a lock too many, which reconciliation cleans up on
   * the next boot. Doing it the other way round would leave a session that believes it
   * is running with its site already handed to somebody else.
   */
  async function finalize(
    sessionId: string,
    siteId: string,
    state: SessionState,
    reason: string | undefined,
    /** EXPLICIT, not deduced from `state`: `stop` also ends in `cancelled` and does notify. */
    notify: boolean,
  ): Promise<void> {
    if (finalized.has(sessionId)) return
    finalized.add(sessionId)

    // The `result` message usually wrote the terminal state already. Appending it
    // again would make the log say the same thing twice.
    const page = await store.read(sessionId, 0)
    if (page.state !== state) await store.append(sessionId, { kind: 'state', state, reason })

    await store.patchMeta(sessionId, (current) => ({
      ...current,
      state,
      endedAt: setup.now().toISOString(),
      reason: reason ?? current.reason,
      agentPid: undefined,
    }))
    // AFTER the meta: a crash from here on leaves a terminal meta, so reconcile does not announce
    // the same end again. Before the lock: `turnOver` in the tests waits on the lock.
    if (notify) announce(sessionId, siteId, state, reason)
    await locks.release(siteId)
    live.delete(sessionId)
  }

  function stateOf(
    exit: AgentExit,
    reported: { state: SessionState; reason: string | undefined } | undefined,
  ): { state: SessionState; reason: string | undefined } {
    // The stream's own verdict wins when it says the run failed, because it knows why
    // — "ran out of turns" is more use than "exited with code 0".
    if (reported?.state === 'failed') return reported
    if (exit.code === 0) return { state: 'finished', reason: undefined }
    if (exit.signal !== null) return { state: 'cancelled', reason: `stopped with ${exit.signal}` }
    return { state: 'failed', reason: exit.stderr === '' ? `exited with code ${exit.code}` : exit.stderr }
  }

  function spawnFor(
    sessionId: string,
    site: Site,
    invoke: Invoke,
    text: string,
    settingsPath: string,
    resume: boolean,
  ): Live {
    /**
     * FINALIZE IS THE ONLY THING THAT WRITES A TERMINAL STATE, and this is where that
     * is enforced.
     *
     * The stream emits its own terminal state the moment the CLI says it is done —
     * which is BEFORE the process has closed and therefore before the lock has come
     * back. Persisting it there makes the log say "finished" while the site is still
     * held, so a screen that polls sees a finished session and gets a 409 when it
     * tries to launch the next one. The verdict is remembered here and used by
     * `finalize`, which runs when the lock is actually being released.
     */
    let reported: { state: SessionState; reason: string | undefined } | undefined

    const run = runAgent({
      sessionId,
      invoke,
      input: text,
      settingsPath,
      resume,
      cwd: site.path,
      onEvent: async (event) => {
        if (event.kind === 'state' && event.state !== 'running') {
          reported = { state: event.state, reason: event.reason }
          return
        }
        await store.append(sessionId, event)
      },
      ...(deps.bin !== undefined ? { bin: deps.bin } : {}),
    })

    const entry: Live = {
      run,
      siteId: site.id,
      cancelled: false,
      settled: Promise.resolve(),
    }

    // THE ONE PLACE A SESSION ENDS. Whether it was cancelled is read from the flag and
    // never inferred from the exit code, which for a group killed with SIGTERM is an
    // ordinary-looking 143.
    Object.assign(entry, {
      settled: run.done.then(async (exit) => {
        const { state, reason } = entry.cancelled
          ? ({ state: 'cancelled' as SessionState, reason: CANCELLED_REASON })
          : stateOf(exit, reported)
        // THE LIVE CANCEL PATH ENDS HERE, not in `cancel()`: `cancel` marks the flag, kills, and
        // awaits this promise. So "the owner cancelled from the phone, do not buzz it back" is
        // decided here, from the same flag that picks the state (criterion 51).
        await finalize(sessionId, site.id, state, reason, !entry.cancelled)
      }),
    })

    live.set(sessionId, entry)
    return entry
  }

  // --- launch --------------------------------------------------------------

  async function launch(input: LaunchInput): Promise<LaunchResult> {
    if (stopped) throw new Error(STOPPED)

    const site = sites.get(input.siteId)
    if (site === undefined) return { outcome: 'rejected', reason: `no site "${input.siteId}" is declared` }

    const entry = findInvokable(catalog, input.entryId)
    if (!entry.ok) return { outcome: 'rejected', reason: entry.reason }

    const sessionId = uuidv7(setup.now().getTime())
    const acquired = await locks.acquire(input.siteId, sessionId, setup.now().toISOString())
    if (!acquired.ok) {
      const holder = acquired.heldBy
      if (holder === undefined) {
        return {
          outcome: 'rejected',
          reason: `site "${input.siteId}" is locked but the lock cannot be read; restart factotum to clear it`,
        }
      }
      return { outcome: 'busy', sessionId: holder.sessionId }
    }

    // EVERYTHING FROM HERE TO THE SUBPROCESS IS INSIDE THE try/finally, AND THAT IS
    // THE POINT OF IT. Between taking the lock and handing it to a live session there
    // is a `git fetch` with a timeout, a settings file, and a spawn — any of which can
    // fail. Without this, the site stays locked until the next restart and the 409
    // that follows hands the screen a session id with no session behind it.
    let handedOver = false
    try {
      if (site.isRepo && !input.force) {
        const report = await checkFreshness({ cwd: site.path, timers: setup.timers })
        if (!isFresh(report)) return { outcome: 'stale', freshness: report }
      }

      const settingsPath = await writeSettings(sessionId)
      await store.create({
        id: sessionId,
        siteId: site.id,
        entryId: input.entryId,
        startedAt: setup.now().toISOString(),
        // So resuming can tell the site moved under the same id (criterion 33).
        sitePath: site.path,
        // So the drawer can tell sessions apart without reading their logs (spec D8d).
        prompt: input.text.slice(0, PROMPT_CHARS),
      })

      if (site.isRepo && input.force) {
        const report = await checkFreshness({ cwd: site.path, timers: setup.timers })
        // The report becomes the first thing in the log, so "I launched over a warning"
        // is recoverable later rather than a thing the owner has to remember.
        await store.append(sessionId, {
          kind: 'message',
          role: 'user',
          text: `launched over a freshness warning: ${describeFreshness(report)}`,
        })
      }

      const running = spawnFor(sessionId, site, entry.invoke, input.text, settingsPath, false)
      await store.patchMeta(sessionId, (current) => ({ ...current, agentPid: running.run.pid }))
      await store.append(sessionId, { kind: 'state', state: 'running', reason: undefined })

      handedOver = true
      return { outcome: 'started', sessionId }
    } finally {
      if (!handedOver) await locks.release(input.siteId)
    }
  }

  // --- reply ---------------------------------------------------------------

  async function reply(id: string, text: string, force: boolean): Promise<LaunchResult> {
    if (stopped) throw new Error(STOPPED)

    const meta = await store.readMeta(id)
    if (meta === undefined) return { outcome: 'rejected', reason: `no session "${id}"` }
    if (meta.state === 'running') return { outcome: 'rejected', reason: 'that session is still running' }

    const site = sites.get(meta.siteId)
    if (site === undefined) return { outcome: 'rejected', reason: `site "${meta.siteId}" is no longer declared` }

    // THE ID STILL RESOLVES, BUT TO WHERE? A config can move an id to another directory, and
    // `--resume` would carry on a thread whose context describes the old tree inside the new one.
    // Both paths in the message: "it moved" alone sends someone to read the config by hand.
    if (meta.sitePath !== undefined && meta.sitePath !== site.path) {
      return {
        outcome: 'rejected',
        reason:
          `site "${meta.siteId}" moved from ${meta.sitePath} to ${site.path} since this session started; ` +
          'resuming would continue its thread in a different directory. Launch a new session there instead.',
      }
    }

    const entry = findInvokable(catalog, meta.entryId)
    if (!entry.ok) return { outcome: 'rejected', reason: entry.reason }

    // The lock is ASKED FOR AGAIN. Holding it across a finished session would block the
    // site for ever; not asking would let a second turn work on a site another session
    // has changed underneath it. So resuming can be refused, exactly like launching.
    const acquired = await locks.acquire(meta.siteId, id, setup.now().toISOString())
    if (!acquired.ok) {
      const holder = acquired.heldBy
      if (holder === undefined) {
        return { outcome: 'rejected', reason: `site "${meta.siteId}" is locked but the lock cannot be read` }
      }
      return { outcome: 'busy', sessionId: holder.sessionId }
    }

    let handedOver = false
    try {
      // FRESHNESS, AFTER THE LOCK AND BEFORE ANYTHING IS WRITTEN — and the second half is the one
      // that matters. After the lock, like `launch`: checking a repository another agent may be
      // changing measures nothing. Before `patchMeta`, UNLIKE where "the same as launch" would put
      // it: in `launch` nothing is written yet at this point, but here the next statement sets
      // `running` and bumps `turns`, and a refusal after it would strand a running session with no
      // process and a turn that never happened (criterion 49).
      let forcedOver: string | undefined
      if (site.isRepo) {
        const report = await checkFreshness({ cwd: site.path, timers: setup.timers })
        if (!isFresh(report)) {
          if (!force) return { outcome: 'stale', freshness: report }
          forcedOver = describeFreshness(report)
        }
      }

      const settingsPath = await writeSettings(id)
      finalized.delete(id)
      await store.patchMeta(id, (current) => ({
        ...current,
        state: 'running',
        endedAt: undefined,
        reason: undefined,
        turns: current.turns + 1,
      }))
      // Written into the log so "I resumed over a warning" is recoverable later, like launch does.
      if (forcedOver !== undefined) {
        await store.append(id, { kind: 'message', role: 'user', text: `resumed over a freshness warning: ${forcedOver}` })
      }
      // A session from before `sitePath` existed: said, not assumed (criterion 35).
      if (meta.sitePath === undefined) {
        await store.append(id, {
          kind: 'message',
          role: 'user',
          text: `the site's path could not be compared: this session predates the check. Resumed in ${site.path}.`,
        })
      }
      await store.append(id, { kind: 'message', role: 'user', text })

      const running = spawnFor(id, site, entry.invoke, text, settingsPath, true)
      await store.patchMeta(id, (current) => ({ ...current, agentPid: running.run.pid }))
      await store.append(id, { kind: 'state', state: 'running', reason: undefined })

      handedOver = true
      return { outcome: 'started', sessionId: id }
    } finally {
      if (!handedOver) await locks.release(meta.siteId)
    }
  }

  // --- cancel --------------------------------------------------------------

  /**
   * Three actions, and the order between them is what criterion 18 checks.
   *
   * KILL, THEN WAIT FOR THE GROUP TO BE GONE, THEN the terminal state, THEN the lock.
   * The criterion says no `claude` descendant is alive afterwards, so waiting is not
   * optional: returning as soon as the signal was sent would let the screen say
   * "cancelled" while the agent was still writing to the repository, and would let the
   * next launch take the lock while it did.
   */
  async function cancel(id: string): Promise<void> {
    const entry = live.get(id)
    if (entry === undefined) {
      // Not running here. Either already over, or it belongs to a daemon that died —
      // in which case reconciliation owns it and has already closed it.
      const meta = await store.readMeta(id)
      if (meta?.state === 'running') {
        await finalize(id, meta.siteId, 'cancelled', 'cancelled while nothing was running', false)
      }
      return
    }

    entry.cancelled = true
    entry.run.kill()
    // WAITING IS NOT OPTIONAL. Criterion 18 says no `claude` descendant is alive
    // afterwards, so returning as soon as the signal was sent would let the screen say
    // "cancelled" while the agent was still writing to the repository — and would let
    // the next launch take the lock while it did.
    await entry.settled.catch(() => undefined)
  }

  // --- reading -------------------------------------------------------------

  function summaryOf(meta: SessionMeta): SessionSummary {
    return {
      id: meta.id,
      siteId: meta.siteId,
      entryId: meta.entryId,
      state: meta.state,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
      reason: meta.reason,
      turns: meta.turns,
      prompt: meta.prompt,
    }
  }

  async function list(page: Page): Promise<SessionPage> {
    const ids = await store.listIds()
    const from = Math.max(0, page.page) * PAGE_SIZE
    const slice = ids.slice(from, from + PAGE_SIZE)

    const sessions: SessionSummary[] = []
    for (const id of slice) {
      const meta = await store.readMeta(id)
      if (meta !== undefined) sessions.push(summaryOf(meta))
    }
    return { sessions, page: Math.max(0, page.page), hasMore: ids.length > from + PAGE_SIZE }
  }

  async function read(id: string, fromSeq: number): Promise<EventPage> {
    const page = await store.read(id, Math.max(0, fromSeq))
    return { events: page.events, nextSeq: page.nextSeq, state: page.state }
  }

  // --- the gate ------------------------------------------------------------

  /**
   * Where a `session_id` becomes a site.
   *
   * The hook's URL is the same for every session, so this is the only thing that says
   * whose boundary is being checked. An id that matches no session is DENIED and never
   * resolved against some default — there is no default site, and inventing one would
   * be choosing where somebody unrecognised gets to write.
   */
  async function decide(payload: unknown): Promise<HookDecision> {
    if (stopped) throw new Error(STOPPED)

    const parsed = preToolUsePayloadSchema.safeParse(payload)
    if (!parsed.success) {
      return denyBody(`factotum could not read the hook payload: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
    }

    const body = parsed.data
    const meta = await store.readMeta(body.session_id)
    if (meta === undefined) {
      return denyBody(`factotum does not recognise session ${body.session_id}`)
    }

    const site = sites.get(meta.siteId)
    if (site === undefined) {
      return denyBody(`session ${body.session_id} belongs to site "${meta.siteId}", which is no longer declared`)
    }

    const result = decidePure({
      toolName: body.tool_name,
      toolInput: body.tool_input,
      cwd: body.cwd,
      site,
      shared,
      // Asked HERE and handed in as data, so `decide` stays pure. Synchronous by contract: no
      // I/O happens before the gate knows whether it may ask (ADR-0008).
      canAsk: setup.notify.canReach(),
    })

    if (result.decision === 'ask') {
      const target = resolveTarget(body.tool_input, body.cwd)
      const preview = previewOf(body.tool_name, body.tool_input)
      return await askTheOwner(body.session_id, meta.siteId, body.tool_name, target, preview, result.reason)
    }

    if (result.decision === 'deny') {
      // The reason goes into the log as well as back to the agent, so the owner finds
      // out at the time rather than from the diff. An ALLOW writes nothing: a gate
      // that narrates its successes is a gate nobody reads (criterion 2).
      await store.append(body.session_id, {
        kind: 'result',
        name: body.tool_name,
        ok: false,
        summary: `denied: ${result.reason}`,
      })
    }

    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.decision, permissionDecisionReason: result.reason } }
  }

  /**
   * THE HELD REPLY. The CLI is waiting on this HTTP response, and it will wait up to
   * HOOK_TIMEOUT_SECONDS (measured, spec §0.32); this gives up ASK_ANSWER_MARGIN_SECONDS before
   * that, so the log can say nobody answered instead of inheriting the CLI's silence.
   *
   * No new session state. The session is `running`, and truly: its process is alive, blocked on
   * this reply. The screen knows something is waiting because the stream already carries the
   * `tool` event — measured to arrive BEFORE the hook is even called (spec §0.32, A10) — with no
   * `result` yet. The outcome is written as that `result`.
   *
   * THE ORDER IS THE DESIGN: the ask is OPEN before the notice goes out, or an owner quick
   * enough would answer an id that does not exist yet. And the reply sent to the CLI is only ever
   * allow or deny: `ask` is this engine's word, never the CLI's.
   */
  async function askTheOwner(
    sessionId: string,
    siteId: string,
    toolName: string,
    target: string | undefined,
    preview: AskPreview | null,
    boundaryReason: string,
  ): Promise<HookDecision> {
    const { id, outcome, deadlineAt } = asks.open({ sessionId, toolName, target: target ?? '', preview })
    const file = target === undefined ? 'a file' : basename(target)

    const notice: NotificationMessage = {
      title: 'approval',
      // The FILE NAME, never the path: this leaves the tailnet (spec §5). The full path is on the
      // screen, which does not.
      body: `${siteId} · ${toolName} · ${file}`,
      // The SESSION, not the token: a tag reaches OS surfaces nothing here controls.
      tag: `ask:${sessionId}`,
      // The token in the URL is what makes answering possible without notification buttons: the
      // shell hands `search` to the screen once and strips it before the first render (criteria
      // 55, 58). The daemon keeps it in memory only; the device keeps it while pending (ADR-0010).
      path: `/m/sessions/${sessionId}?ask=${id}`,
      // What the client's drawer shows without parsing `body`. The file NAME again, never the
      // path, and never the preview: all of this leaves the tailnet.
      data: { askId: id, sessionId, siteId, toolName, file },
      // Pending until then: the client counts it and can answer it without the notification.
      until: deadlineAt,
    }
    void Promise.resolve()
      .then(() => setup.notify.send(notice))
      .catch((error: unknown) => log.warn(`an ask notice for session ${sessionId} could not be sent: ${error instanceof Error ? error.name : 'error'}`))

    const settled = await outcome

    const [decision, reason, ok, summary] = ((): ['allow' | 'deny', string, boolean, string] => {
      switch (settled.kind) {
        case 'answered':
          return settled.decision === 'allow'
            ? ['allow', 'approved by the owner', true, 'approved by the owner']
            : ['deny', `denied by the owner: ${boundaryReason}`, false, `denied by the owner: ${boundaryReason}`]
        case 'expired': {
          const said = `nobody answered in time; not granted: ${boundaryReason}`
          return ['deny', said, false, said]
        }
        case 'shutdown':
          return ['deny', settled.reason, false, `not granted: ${settled.reason}`]
      }
    })()

    await store.append(sessionId, { kind: 'result', name: toolName, ok, summary })
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }
  }

  /** The owner's answer. The id is the only authorisation there is (spec §5). */
  async function answer(askId: string, decision: 'allow' | 'deny'): Promise<TableAnswer> {
    return asks.answer(askId, decision)
  }

  async function inspect(askId: string): Promise<InspectResult> {
    const found = asks.get(askId)
    if (found === undefined) return { kind: 'unknown' }
    if (found === 'settled') return { kind: 'settled' }
    return {
      kind: 'pending',
      sessionId: found.sessionId,
      toolName: found.toolName,
      target: found.target,
      preview: found.preview,
      deadlineAt: found.deadlineAt,
    }
  }

  // --- lifecycle -----------------------------------------------------------

  async function reconcile(): Promise<void> {
    // Runs inside `start()`, which the registry bounds with MODULE_START_TIMEOUT_MS. So the
    // notices reconcile raises are NOT awaited — `announce` never is — or a slow push service
    // could get the whole module disabled at boot (spec D7).
    await reconcileLocks({ store, locks, log, now: setup.now, announce })
  }

  function view(): EngineSetupView {
    return {
      sites: [...sites.values()].map((site) => ({ id: site.id, path: site.path, isRepo: site.isRepo })),
      catalog: catalog.map((entry) => ({
        id: entry.id,
        label: entry.label,
        disabledReason: entry.disabledReason,
      })),
    }
  }

  /**
   * NO TIMER IS ARMED HERE. `registry.ts:218-222` disposes a module's timers AFTER
   * calling `stop()`, so one armed in here would have no owner.
   *
   * Which is why this does not wait for the groups to die: it signals them, writes each
   * session terminal, and LEAVES THE LOCK. Leaving it is deliberate — the next boot's
   * reconciliation finds a lock over a terminal session and releases it, and until then
   * the site stays closed. And anything that somehow survived SIGTERM has an
   * unreachable hook, which block A measured the CLI treating as "not granted": every
   * tool it tries is blocked.
   */
  async function stop(): Promise<void> {
    stopped = true
    // FIRST: every held reply resolves as a deny now, before anything is killed. An ask must not
    // outlive the engine as a promise nobody will ever settle (criterion 22).
    asks.closeAll(SHUTDOWN_REASON)

    for (const [sessionId, entry] of live) {
      try {
        entry.run.kill()
      } catch {
        // Already gone. That is the outcome that was wanted.
      }
      finalized.add(sessionId)
      await store.append(sessionId, { kind: 'state', state: 'cancelled', reason: SHUTDOWN_REASON })
      await store.patchMeta(sessionId, (current) => ({
        ...current,
        state: 'cancelled',
        endedAt: setup.now().toISOString(),
        reason: SHUTDOWN_REASON,
      }))
      // AFTER patchMeta, never after the append alone: dying between the two used to leave the
      // meta `running`, and the next boot's reconcile would announce this end a second time
      // (criterion 45). NOT awaited — see `announce`: the kernel drains notices in flight after
      // this returns, each bounded by its own signal, so this arms no timer (criterion 50) and
      // N live sessions cost one bound, not N (criterion 48).
      announce(sessionId, entry.siteId, 'cancelled', SHUTDOWN_REASON)
    }
    live.clear()
  }

  return { launch, reply, cancel, answer, inspect, list, read, decide, reconcile, view, stop }
}
