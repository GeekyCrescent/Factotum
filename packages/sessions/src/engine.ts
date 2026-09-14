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
import type { Logger } from '@factotum/core'
import { findInvokable, resolveCatalog, type Invoke, type ResolvedEntry } from './catalog.ts'
import { checkFreshness, describeFreshness, isFresh } from './freshness.ts'
import { uuidv7 } from './id.ts'
import { reconcile as reconcileLocks } from './lifecycle.ts'
import { SiteLocks } from './locks.ts'
import { sessionPaths } from './paths.ts'
import { decide as decidePure } from './permissions/decide.ts'
import { denyBody, preToolUsePayloadSchema } from './permissions/payload.ts'
import { hookSettings, serializeSettings } from './permissions/settings.ts'
import { runAgent, type AgentExit, type AgentRun } from './run.ts'
import { inspectSite, type Site } from './sites.ts'
import { SessionStore, type SessionMeta } from './store.ts'
import type {
  EngineSetup,
  EngineSetupView,
  EventPage,
  HookDecision,
  LaunchInput,
  LaunchResult,
  Page,
  SessionEngine,
  SessionPage,
  SessionState,
  SessionSummary,
} from './types.ts'

export const PAGE_SIZE = 25

const STOPPED = 'engine stopped'

/**
 * A seam, and the only one, for exactly the reason the kernel's `makeServer` is one:
 * the alternative is a test that spends quota to prove that a pipe was read.
 */
export interface EngineDeps {
  readonly bin?: string
}

interface Live {
  readonly run: AgentRun
  readonly siteId: string
  /** Resolves when the terminal state is on disk and the lock is back. */
  readonly settled: Promise<void>
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

  const catalog: readonly ResolvedEntry[] = resolveCatalog(setup.catalog)
  for (const entry of catalog) {
    if (entry.disabledReason !== undefined) {
      log.warn(`catalog entry "${entry.id}" is disabled: ${entry.disabledReason}`)
    }
  }

  const live = new Map<string, Live>()
  const finalized = new Set<string>()
  let stopped = false

  // --- the pieces launch and reply share ----------------------------------

  async function writeSettings(sessionId: string): Promise<string> {
    await store.ensureDir(sessionId)
    const path = store.settingsFile(sessionId)
    // `baseUrl()` throws while the composition root has not filled the thunk in. That
    // is on purpose and it is the last thing that can go wrong before a subprocess
    // exists: a session launched with an unreachable hook is a session with no gate.
    await writeFile(path, serializeSettings(hookSettings(setup.baseUrl())), 'utf8')
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

    const settled = run.done.then(async (exit) => {
      const { state, reason } = stateOf(exit, reported)
      await finalize(sessionId, site.id, state, reason)
    })

    const entry: Live = { run, siteId: site.id, settled }
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

  async function reply(id: string, text: string): Promise<LaunchResult> {
    if (stopped) throw new Error(STOPPED)

    const meta = await store.readMeta(id)
    if (meta === undefined) return { outcome: 'rejected', reason: `no session "${id}"` }
    if (meta.state === 'running') return { outcome: 'rejected', reason: 'that session is still running' }

    const site = sites.get(meta.siteId)
    if (site === undefined) return { outcome: 'rejected', reason: `site "${meta.siteId}" is no longer declared` }

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
      const settingsPath = await writeSettings(id)
      finalized.delete(id)
      await store.patchMeta(id, (current) => ({
        ...current,
        state: 'running',
        endedAt: undefined,
        reason: undefined,
        turns: current.turns + 1,
      }))
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
        await finalize(id, meta.siteId, 'cancelled', 'cancelled while nothing was running')
      }
      return
    }

    await store.append(id, { kind: 'state', state: 'cancelled', reason: 'cancelled by the owner' })
    finalized.delete(id)
    entry.run.kill()
    await entry.run.done
    await finalize(id, entry.siteId, 'cancelled', 'cancelled by the owner')
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
    })

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

  // --- lifecycle -----------------------------------------------------------

  async function reconcile(): Promise<void> {
    await reconcileLocks({ store, locks, log, now: setup.now })
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

    for (const [sessionId, entry] of live) {
      try {
        entry.run.kill()
      } catch {
        // Already gone. That is the outcome that was wanted.
      }
      finalized.add(sessionId)
      await store.append(sessionId, {
        kind: 'state',
        state: 'cancelled',
        reason: 'the daemon was shutting down',
      })
      await store.patchMeta(sessionId, (current) => ({
        ...current,
        state: 'cancelled',
        endedAt: setup.now().toISOString(),
        reason: 'the daemon was shutting down',
      }))
    }
    live.clear()
  }

  return { launch, reply, cancel, list, read, decide, reconcile, view, stop }
}
