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

import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { MAX_UPLOAD_BYTES, type Logger, type NotificationMessage } from '@factotum/core'
import { createAnnounced } from './announced.ts'
import { findInvokable, resolveCatalog, type Invoke, type ResolvedEntry } from './catalog.ts'
import { checkFreshness, describeFreshness, isFresh, type FreshnessDeps } from './freshness.ts'
import { uuidv7 } from './id.ts'
import { createLister, listFiles, MAX_ENTRIES } from './listing.ts'
import { CRASH_REASON, ORPHAN_REASON, reconcile as reconcileLocks } from './lifecycle.ts'
import { noticeFor } from './notices.ts'
import { REMOVING_HOLDER, SiteLocks, type LockMode } from './locks.ts'
import { sessionPaths } from './paths.ts'
import { createAskTable, type AnswerResult as TableAnswer } from './permissions/asks.ts'
import { decide as decidePure, resolveTarget } from './permissions/decide.ts'
import { previewOf, type AskPreview } from './permissions/preview.ts'
import { agentOf, denyBody, preToolUsePayloadSchema } from './permissions/payload.ts'
import { ASK_TIMEOUT_SECONDS, hookSettings, serializeSettings } from './permissions/settings.ts'
import { PAGE_SIZE } from './history.ts'
import { createCallers } from './callers.ts'
import { mcpConfig, serializeMcpConfig } from './questions/config.ts'
import { handleMcp } from './questions/mcp.ts'
import { createQuestions } from './questions/owner.ts'
import { createParts } from './parts.ts'
import { runAgent, type AgentExit, type AgentRun } from './run.ts'
import { searchHistory } from './search.ts'
import { usageOver } from './usage.ts'
import { createServices, type ServiceSeams } from './services/wire.ts'
import type { DiskProbe, Site } from './sites.ts'
import { SessionStore, type RemoveOutcome } from './store.ts'
import { createTitler } from './titler/index.ts'
import { ownerUploadIds, promptOf, stripRefs } from './uploads/refs.ts'
import { createUploadStore } from './uploads/store.ts'
import type {
  EngineSetup,
  FreshnessReport,
  EngineSetupView,
  EventInput,
  EventPage,
  HookDecision,
  InspectResult,
  InvalidId,
  LaunchInput,
  LaunchResult,
  SessionEngine,
  SessionState,
  SiteMissing,
} from './types.ts'
import { isSessionId } from './id.ts'

export { PAGE_SIZE }

/** How much of the first prompt a session summary keeps (spec D8d). */
export const PROMPT_CHARS = 140

const STOPPED = 'engine stopped'
const BEING_REMOVED = 'this project is being removed'
const DELETED = 'that conversation was deleted'
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
  /** Whether the rules for a folder ignore case. Defaults to macOS; a test picks. */
  readonly caseInsensitive?: boolean
  /** The disk the folder rules read, so a test can hang it (criterion 15). */
  readonly disk?: DiskProbe
  /** The ceiling of one folder check, so a test does not wait for it. */
  readonly checkMs?: number
  /** How long a folder request waits for the owner. A test cannot wait ten minutes. */
  readonly grantTimeoutMs?: number
  /** The ceiling of checking a new folder (5 s), so a test can hang one and not wait. */
  readonly candidateTimeoutMs?: number
  /** How long the titler waits for `claude`. A test cannot wait thirty seconds. */
  readonly titlerTimeoutMs?: number
  /** The services' shell and registry, so a test runs `/bin/sh` and can hold a start (spec 2026-10-02). */
  readonly serviceSeams?: ServiceSeams
  /** The freshness check `launch` runs, so a test can hold one without a network (spec 2026-10-03, D7). */
  readonly freshness?: (deps: FreshnessDeps) => Promise<FreshnessReport>
}

/** The per-session files the CLI is launched with. */
interface SessionFiles {
  readonly settings: string
  readonly mcp: string
}

/** What a lock holds while a project is being deleted: not a session id, so nothing mistakes it. */
export const REMOVING = REMOVING_HOLDER

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
  const freshness = deps.freshness ?? checkFreshness
  await store.ensureRoots()

  // What the CLI announces it can invoke (spec 2026-10-03-skills-a-mano, D2): read once here, and
  // refreshed by the `init` of any turn, a reply included.
  const announced = createAnnounced({ file: paths.announcedFile, log, now: setup.now })
  await announced.load()

  /**
   * How a launch or a reply in this project asks for its lock (spec 2026-10-03, D4). A THUNK, read
   * inside the lock's queue, so a switch turned a moment ago is the one that counts. A project that is
   * not registered is exclusive: nothing widens by accident.
   */
  const modeFor =
    (siteId: string) =>
    (): LockMode =>
      table.entry(siteId)?.concurrent === true ? 'shared' : 'exclusive'

  const live = new Map<string, Live>()
  const isLive = (id: string): boolean => live.has(id)

  // What the owner attaches (spec 2026-10-01, D5). BEFORE the parts: deleting a conversation, which
  // they are handed, deletes its uploads too.
  const uploads = createUploadStore({
    root: paths.uploads,
    maxBytes: setup.uploadMaxBytes ?? MAX_UPLOAD_BYTES,
    now: setup.now,
    log,
  })
  // Listing folders for `@` references (spec 2026-10-01-referencias-y-tab, D4): one per engine.
  const lister = createLister({ timers: setup.timers })

  /**
   * The uploads a conversation's OWNER sent in it — never a path its agent read or quoted (D6). An
   * empty list at the first doubt: a directory that is a link is not read through, the same thing
   * `store.remove` refuses to follow.
   */
  async function ownerUploadsOf(id: string): Promise<readonly string[]> {
    if (!isSessionId(id)) return []
    try {
      if ((await lstat(store.sessionDir(id))).isSymbolicLink()) return []
      const page = await store.read(id, 0)
      return ownerUploadIds(page.events, uploads.root)
    } catch {
      return []
    }
  }

  /**
   * THE ONE WAY A CONVERSATION IS DELETED (D6): the history, a removed project and a removed project's
   * leftovers all come through here. The events are read in `store.read`'s own turn, before
   * `store.remove` takes its: a conversation that may be deleted is not live, so its agent writes
   * nothing in between — only its services' `ended`, stopped first so no process outlives the folder
   * (spec 2026-10-02, criterion 22). A reply that starts in between makes `remove` answer `running`.
   */
  async function removeConversation(id: string): Promise<RemoveOutcome> {
    // A conversation that cannot be deleted keeps its services (criterion 22).
    if (isLive(id) || (await store.readMeta(id))?.state === 'running') return 'running'
    await services.table.stopSession(id, 'stopped')
    const owned = await ownerUploadsOf(id)
    const outcome = await store.remove(id, isLive)
    if (outcome === 'removed') await uploads.forget(owned)
    return outcome
  }

  // The projects, the history index and the folder requests (spec 2026-09-29), composed in
  // `parts.ts`. A folder that is not there no longer disables the module: it fails alone (ADR-0011).
  const { table, index, ensureIndex, history, grants, folders } = await createParts(setup, deps, {
    store,
    locks,
    liveCount: () => live.size,
    isLive,
    removing: REMOVING,
    removeConversation,
  })

  // The titler (spec 2026-09-30, D7). Handed ONE function that writes, never the store: it cannot
  // take a lock or touch a log. The write keeps a title that is already there (criterion 15).
  await mkdir(paths.titler, { recursive: true })
  const titler = createTitler({
    config: setup.titles,
    cwd: paths.titler,
    timers: setup.timers,
    log,
    write: async (id, title) => await store.patchMeta(id, (meta) => (meta.autoTitle !== undefined ? meta : { ...meta, autoTitle: title })),
    ...(deps.bin !== undefined ? { bin: deps.bin } : {}),
    ...(deps.titlerTimeoutMs !== undefined ? { timeoutMs: deps.titlerTimeoutMs } : {}),
  })

  const catalog: readonly ResolvedEntry[] = resolveCatalog(setup.catalog)
  for (const entry of catalog) {
    if (entry.disabledReason !== undefined) {
      log.warn(`catalog entry "${entry.id}" is disabled: ${entry.disabledReason}`)
    }
  }

  const finalized = new Set<string>()
  let stopped = false
  const asks = createAskTable({
    now: setup.now,
    timers: setup.timers,
    timeoutMs: deps.askTimeoutMs ?? ASK_TIMEOUT_SECONDS * 1000,
  })
  // Who made a call, by tool_use_id: the gate notes, `ask_owner` and `start_service` take (spec 2026-10-02, D8).
  const callers = createCallers()
  // The agent's questions to the owner (spec 2026-10-01-preguntas-con-opciones, D5). The SAME window
  // as an ask: one knob.
  const questions = createQuestions({
    append: async (sessionId, event) => await store.append(sessionId, event),
    siteOf: (sessionId) => live.get(sessionId)?.siteId,
    isStopped: () => stopped,
    notify: setup.notify,
    log,
    now: setup.now,
    timers: setup.timers,
    timeoutMs: deps.askTimeoutMs ?? ASK_TIMEOUT_SECONDS * 1000,
    callers,
  })
  // Background services (spec 2026-10-02-servicios-en-segundo-plano, D10): all in `services/`, wired once.
  // `services`, never `table`: that is `createParts`'.
  const services = createServices({
    store: { append: async (id, event) => await store.append(id, event), read: async (id, from) => await store.read(id, from) },
    paths,
    timers: setup.timers,
    now: setup.now,
    log,
    callers,
    liveSiteId: (sessionId) => live.get(sessionId)?.siteId,
    lastSite: (siteId) => table.lastSite(siteId),
    isStopped: () => stopped,
    ...(deps.serviceSeams !== undefined ? { seams: deps.serviceSeams } : {}),
  })

  /** Closes a session's batches and queues their `settled`. Never rejects: a lost line is logged. */
  function closeQuestions(sessionId: string): Promise<unknown> {
    return questions
      .closeSession(sessionId)
      .catch((error: unknown) => log.warn(`questions of session ${sessionId} could not be closed in the log: ${error instanceof Error ? error.message : 'error'}`))
  }

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

  /**
   * The two files the CLI is handed: the hook's settings and the `--mcp-config` of the questions tool
   * (spec 2026-10-01-preguntas-con-opciones, D4). Both point at the same base URL.
   * `undefined` when the conversation was deleted in the meantime: nothing is written (crit. 33).
   */
  async function writeSessionFiles(sessionId: string): Promise<SessionFiles | undefined> {
    if ((await store.ensureDir(sessionId)) === undefined) return undefined
    // `hookUrl()` throws while the composition root has not filled the thunk in. That
    // is on purpose and it is the last thing that can go wrong before a subprocess
    // exists: a session launched with an unreachable hook is a session with no gate.
    const base = setup.hookUrl()
    const settings = store.settingsFile(sessionId)
    const mcp = store.mcpConfigFile(sessionId)
    await writeFile(settings, serializeSettings(hookSettings(base)), 'utf8')
    await writeFile(mcp, serializeMcpConfig(mcpConfig(base, sessionId)), 'utf8')
    return { settings, mcp }
  }

  /**
   * The lock of a launch or a reply that never reached its agent. A failure here is LOGGED: thrown from
   * a `finally`, it would replace the real outcome or the real error. The lock it leaves closes the
   * project until the next start, which is the side that fails safe.
   */
  async function giveBack(siteId: string, holderId: string): Promise<void> {
    try {
      await locks.release(siteId, holderId)
    } catch (error) {
      log.warn(`the lock of ${holderId} on "${siteId}" could not be released; the next start will: ${error instanceof Error ? error.message : 'error'}`)
    }
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
    // A process that ended by itself with a batch open (criterion 42): closed, and its `settled`
    // written BEFORE the terminal state below. After a Cancel there is nothing left to close.
    await closeQuestions(sessionId)
    // A `start_service` half way when the CLI died: its `started` and `ended` go before the state (criterion 43).
    await services.table.pending(sessionId)

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
    // ITS lock only: in a project with several sessions the siblings keep theirs (criterion 10).
    // A release that fails is LOGGED, not thrown: the meta is already terminal, so the lock left behind
    // is row 4 of the next boot's reconcile — and `live` must lose the session either way.
    try {
      await locks.release(siteId, sessionId)
    } catch (error) {
      log.warn(`the lock of session ${sessionId} could not be released; the next start will: ${error instanceof Error ? error.message : 'error'}`)
    } finally {
      live.delete(sessionId)
    }
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
    files: SessionFiles,
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
    // A Cancel left the session `closing` for services; a new turn may start them again (D5).
    services.table.reopen(sessionId)

    const run = runAgent({
      sessionId,
      invoke,
      input: text,
      settingsPath: files.settings,
      mcpConfigPath: files.mcp,
      resume,
      cwd: site.path,
      onInit: announced.take,
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

  /**
   * The project a launch or a reply would run in, CHECKED AGAIN NOW: a folder that went missing
   * since the last look is refused here, and one that came back is usable (criteria 23, 24).
   */
  async function siteFor(siteId: string): Promise<{ kind: 'ok'; site: Site } | { kind: 'refused'; reason: string }> {
    const check = await table.refresh(siteId)
    if (check === undefined) return { kind: 'refused', reason: `no project "${siteId}" is registered` }
    if (check.status === 'missing') return { kind: 'refused', reason: `the folder of project "${siteId}" is missing: ${check.reason}` }
    return { kind: 'ok', site: check.site }
  }

  /** Reading a conversation of a project whose folder is missing is refused (criterion 25). */
  async function missingFor(siteId: string): Promise<SiteMissing | undefined> {
    const check = await table.refresh(siteId)
    return check?.status === 'missing' ? { kind: 'site-missing', siteId } : undefined
  }

  // --- launch --------------------------------------------------------------

  async function launch(input: LaunchInput): Promise<LaunchResult> {
    if (stopped) throw new Error(STOPPED)

    const found = await siteFor(input.siteId)
    if (found.kind !== 'ok') return { outcome: 'rejected', reason: found.reason }
    const site = found.site

    const entry = findInvokable(catalog, input.entryId)
    if (!entry.ok) return { outcome: 'rejected', reason: entry.reason }

    // Launching as an agent: only from a free-prompt entry, and only a name the CLI itself announced.
    let invoke: Invoke = entry.invoke
    if (input.agent !== undefined) {
      if (invoke.kind !== 'none') return { outcome: 'rejected', reason: 'an agent can only be launched with a free-prompt entry' }
      const list = announced.get()
      if (list === undefined) return { outcome: 'rejected', reason: 'the list of agents is not known yet' }
      if (!list.agents.includes(input.agent)) {
        return { outcome: 'rejected', reason: `no agent "${input.agent}" in the list the CLI announced` }
      }
      invoke = { kind: 'subagent', name: input.agent }
    }

    const sessionId = uuidv7(setup.now().getTime())
    const acquired = await locks.acquire(input.siteId, sessionId, setup.now().toISOString(), modeFor(input.siteId))
    if (!acquired.ok) {
      const holder = acquired.heldBy
      if (holder === undefined) {
        return {
          outcome: 'rejected',
          reason: `site "${input.siteId}" is locked but the lock cannot be read; restart factotum to clear it`,
        }
      }
      if (holder.sessionId === REMOVING) return { outcome: 'rejected', reason: BEING_REMOVED }
      return { outcome: 'busy', sessionId: holder.sessionId }
    }

    // EVERYTHING FROM HERE TO THE SUBPROCESS IS INSIDE THE try/finally, AND THAT IS
    // THE POINT OF IT. Between taking the lock and handing it to a live session there
    // is a `git fetch` with a timeout, a settings file, and a spawn — any of which can
    // fail. Without this, the site stays locked until the next restart and the 409
    // that follows hands the screen a session id with no session behind it.
    let handedOver = false
    try {
      // THE OTHER HOLDERS of this project's lock, counted right after winning it (spec 2026-10-03, D7).
      // Not `live`: a session enters it only after its own `git fetch`, so two launches a second apart
      // would both count none. Only possible in a concurrent project — an exclusive acquire lost.
      // Never below 0: a directory read that failed (EMFILE) must fail TOWARDS checking, not skip it unsaid.
      const siblings = Math.max(0, (await locks.holders(site.id)).length - 1)
      // With siblings the tree is dirty with THEIR edits, and the warning would fire every time — the
      // reason `reply` does not check either. What is not checked is said, in the log, below.
      const checks = site.isRepo && siblings === 0
      if (checks && !input.force) {
        const report = await freshness({ cwd: site.path, timers: setup.timers })
        if (!isFresh(report)) return { outcome: 'stale', freshness: report }
      }

      const files = await writeSessionFiles(sessionId)
      // A fresh id is never a deleted one; said rather than asserted with a cast.
      if (files === undefined) return { outcome: 'rejected', reason: DELETED }
      await store.create({
        id: sessionId,
        siteId: site.id,
        entryId: input.entryId,
        startedAt: setup.now().toISOString(),
        // So resuming can tell the site moved under the same id (criterion 33).
        sitePath: site.path,
        // So the drawer can tell sessions apart without reading their logs (spec D8d).
        // The words, or the names of the files when there are none — never a path (spec 2026-10-01, D7).
        prompt: promptOf(input.text, uploads.root).slice(0, PROMPT_CHARS),
        agent: input.agent,
      })

      if (site.isRepo && siblings > 0) {
        await store.append(sessionId, {
          kind: 'message',
          role: 'user',
          text: `freshness not checked: ${siblings} other session(s) are running in this project`,
        })
      }
      if (checks && input.force) {
        const report = await freshness({ cwd: site.path, timers: setup.timers })
        // The report becomes the first thing in the log, so "I launched over a warning"
        // is recoverable later rather than a thing the owner has to remember.
        await store.append(sessionId, {
          kind: 'message',
          role: 'user',
          text: `launched over a freshness warning: ${describeFreshness(report)}`,
        })
      }
      // The prompt goes into the log the same way a reply does, or the thread opens on an answer.
      // A catalog entry can launch with no text, and an empty bubble says nothing.
      if (input.text.trim() !== '') await store.append(sessionId, { kind: 'message', role: 'user', text: input.text })

      const running = spawnFor(sessionId, site, invoke, input.text, files, false)
      await store.patchMeta(sessionId, (current) => ({ ...current, agentPid: running.run.pid }))
      await store.append(sessionId, { kind: 'state', state: 'running', reason: undefined })

      handedOver = true
      // AFTER the hand-over: before it, a failure would leave nothing to title. Not awaited, and it
      // cannot throw (titler/index.ts), so a started conversation stays started. `reply` never
      // titles, and neither does `reconcile` (criteria 13, 14).
      // Without the reference lines: a path is not what a conversation is about, and a message of
      // files alone leaves nothing, which the titler does not title (spec 2026-10-01, D7).
      titler.start(sessionId, stripRefs(input.text, uploads.root))
      return { outcome: 'started', sessionId }
    } finally {
      if (!handedOver) await giveBack(input.siteId, sessionId)
    }
  }

  // --- reply ---------------------------------------------------------------

  async function reply(id: string, text: string): Promise<LaunchResult> {
    if (stopped) throw new Error(STOPPED)

    if (!isSessionId(id)) return { outcome: 'rejected', reason: `"${id}" is not a session id` }
    const meta = await store.readMeta(id)
    if (meta === undefined) return { outcome: 'rejected', reason: `no session "${id}"` }
    if (meta.state === 'running') return { outcome: 'rejected', reason: 'that session is still running' }

    const found = await siteFor(meta.siteId)
    if (found.kind !== 'ok') return { outcome: 'rejected', reason: found.reason }
    const site = found.site

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
    const acquired = await locks.acquire(meta.siteId, id, setup.now().toISOString(), modeFor(meta.siteId))
    if (!acquired.ok) {
      const holder = acquired.heldBy
      if (holder === undefined) {
        return { outcome: 'rejected', reason: `site "${meta.siteId}" is locked but the lock cannot be read` }
      }
      if (holder.sessionId === REMOVING) return { outcome: 'rejected', reason: BEING_REMOVED }
      return { outcome: 'busy', sessionId: holder.sessionId }
    }

    let handedOver = false
    try {
      // NO FRESHNESS CHECK HERE, on purpose: it runs once, at launch. After the first turn the
      // agent's own edits leave the repo dirty, so checking on every reply warned on every message.
      // A DELETE THAT RAN SINCE THE CHECKS ABOVE: the tombstone refuses the directory and the
      // missing meta refuses the patch. Either way this is `rejected`, and the `finally` gives the
      // lock back — nothing is made again (criterion 33).
      const files = await writeSessionFiles(id)
      if (files === undefined) return { outcome: 'rejected', reason: DELETED }
      finalized.delete(id)
      const reopened = await store.patchMeta(id, (current) => ({
        ...current,
        state: 'running',
        endedAt: undefined,
        reason: undefined,
        turns: current.turns + 1,
      }))
      if (reopened === undefined) return { outcome: 'rejected', reason: DELETED }
      // A session from before `sitePath` existed: said, not assumed (criterion 35).
      if (meta.sitePath === undefined) {
        await store.append(id, {
          kind: 'message',
          role: 'user',
          text: `the site's path could not be compared: this session predates the check. Resumed in ${site.path}.`,
        })
      }
      await store.append(id, { kind: 'message', role: 'user', text })

      const running = spawnFor(id, site, entry.invoke, text, files, true)
      await store.patchMeta(id, (current) => ({ ...current, agentPid: running.run.pid }))
      await store.append(id, { kind: 'state', state: 'running', reason: undefined })

      handedOver = true
      return { outcome: 'started', sessionId: id }
    } finally {
      if (!handedOver) await giveBack(meta.siteId, id)
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
        await services.table.stopSession(id, 'cancelled')
        await finalize(id, meta.siteId, 'cancelled', 'cancelled while nothing was running', false)
      }
      return
    }

    // NO await BETWEEN THESE THREE (spec 2026-10-01-preguntas-con-opciones, D5). Marked, its batches
    // closed with their `settled` queued, THEN killed: with an await before the kill, the held call
    // would answer "cancelled" to a CLI still alive, and a process ending in that gap would finish.
    entry.cancelled = true
    // Its services too: their `ended` queued now, before the kill; the promise also waits for their deaths.
    const closing = Promise.all([closeQuestions(id), services.table.stopSession(id, 'cancelled')])
    entry.run.kill()
    await closing
    // WAITING IS NOT OPTIONAL. Criterion 18 says no `claude` descendant is alive
    // afterwards, so returning as soon as the signal was sent would let the screen say
    // "cancelled" while the agent was still writing to the repository — and would let
    // the next launch take the lock while it did.
    await entry.settled.catch(() => undefined)
  }

  // --- reading -------------------------------------------------------------

  async function read(id: string, fromSeq: number): Promise<EventPage | SiteMissing | InvalidId> {
    if (!isSessionId(id)) return { kind: 'invalid' }
    const meta = await store.readMeta(id)
    if (meta !== undefined) {
      const missing = await missingFor(meta.siteId)
      if (missing !== undefined) return missing
    }
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

    // THE LAST CHECK THAT WAS OK, never a fresh one: a live session keeps the boundary it started
    // with when its folder goes missing (criterion 23), and the gate does no I/O it can avoid.
    const site = table.lastSite(meta.siteId)
    if (site === undefined) {
      return denyBody(`session ${body.session_id} belongs to site "${meta.siteId}", which is no longer declared`)
    }

    const result = decidePure({
      toolName: body.tool_name,
      toolInput: body.tool_input,
      cwd: body.cwd,
      site,
      shared: table.gateShared(),
      // Asked HERE and handed in as data, so `decide` stays pure. Synchronous by contract: no
      // I/O happens before the gate knows whether it may ask (ADR-0008).
      canAsk: setup.notify.canReach(),
    })

    // Whose call this was. Only for the log — `decidePure` never sees it, so a subagent is held to
    // exactly the boundary the main agent is (spec 2026-10-01-subagentes-visibles, guardrail 6).
    const task = agentOf(body)
    const target = resolveTarget(body.tool_input, body.cwd)
    // Who is about to call `ask_owner`, by tool_use_id: the MCP call does not say (requirements §0.3).
    callers.note({ toolName: body.tool_name, toolUseId: body.tool_use_id, agentId: task, sessionId: body.session_id })

    if (result.decision === 'ask') {
      const preview = previewOf(body.tool_name, body.tool_input)
      return await askTheOwner(body.session_id, meta.siteId, body.tool_name, target, preview, result.reason, task)
    }

    // A `quiet` deny is a redirect, not a boundary hit: the agent is told, the log is not (spec 2026-10-02, D9).
    if (result.decision === 'deny' && result.quiet !== true) {
      // The reason goes into the log as well as back to the agent, so the owner finds
      // out at the time rather than from the diff. An ALLOW writes nothing: a gate
      // that narrates its successes is a gate nobody reads (criterion 2).
      await store.append(body.session_id, gateResult(body.tool_name, false, `denied: ${result.reason}`, task, target))
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
    task: string | undefined,
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

    await store.append(sessionId, gateResult(toolName, ok, summary, task, target))
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }
  }

  /**
   * What the gate writes to the log about a call. For the MAIN agent it is what it always was, byte for
   * byte: its own call is already in the log, path and all. A SUBAGENT's call is not (the translator
   * drops its lines), so the result says whose it was and what it touched — otherwise the owner reads
   * "approved by the owner" with no idea what was approved (spec 2026-10-01-subagentes, criterion 37).
   *
   * The path goes in front only when the summary does not already say it: a refusal's reason names it
   * ("writes outside work: /x"), an approval does not. Without a path there is no result to write at
   * all — the gate allows a write it cannot place. The prefix is for the log; the CLI is told the same.
   */
  function gateResult(name: string, ok: boolean, summary: string, task: string | undefined, target: string | undefined): EventInput {
    if (task === undefined) return { kind: 'result', name, ok, summary }
    const said = target === undefined || summary.includes(target) ? summary : `${target}: ${summary}`
    return { kind: 'result', name, ok, summary: said, task }
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
    // AFTER the locks (D6): what the last daemon's services left is killed and closed. Never throws.
    await services.reconcile()
    // AFTER reconciling, so a session a crash left `running` is read as the `failed` it now is.
    await ensureIndex()
  }

  function view(): EngineSetupView {
    return {
      sites: table.sites(),
      catalog: catalog.map((entry) => ({
        id: entry.id,
        label: entry.label,
        disabledReason: entry.disabledReason,
      })),
      uploads: uploads.view,
      files: { maxEntries: MAX_ENTRIES },
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
    // The titler first: the cheapest thing to stop, and nothing depends on it. After this nothing
    // it had in flight writes a title (criterion 12).
    titler.stop()
    // Every held reply resolves as a deny now, before anything is killed. An ask must not
    // outlive the engine as a promise nobody will ever settle (criterion 22).
    asks.closeAll(SHUTDOWN_REASON)
    // Every open batch, as `shutdown`. Its `settled` is queued on its session's log NOW, so it lands
    // before the `cancelled` state the loop below writes (criterion 22).
    const closingQuestions = questions
      .closeAll(SHUTDOWN_REASON)
      .catch((error: unknown) => log.warn(`questions could not be closed in the log: ${error instanceof Error ? error.message : 'error'}`))
    // And every folder request: its approval can no longer be written by anybody.
    grants.closeAll(SHUTDOWN_REASON)
    // Every service, SIGTERM with no rescue; its `ended` before the `cancelled` below. Waits for the WRITES
    // only, never a death (spec 2026-10-02, criteria 24, 43, 44); the next start's reconcile kills the rest.
    await services.table.stopAll(SHUTDOWN_REASON)

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
    await closingQuestions
  }

  /** After `stop`, nothing widens and nothing is deleted: the same rule as launch. */
  const unlessStopped =
    <A extends unknown[], R>(work: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (stopped) throw new Error(STOPPED)
      return await work(...args)
    }

  return {
    launch,
    reply,
    cancel,
    answer,
    inspect,
    list: history.list,
    read,
    decide,
    reconcile,
    announced: announced.get,
    // The IN-MEMORY registry, never `projects()`: that one checks every project on disk, and this
    // runs on every GET /skills.
    pinnedOf: (siteId) => table.entry(siteId)?.pinned ?? [],
    usage: async (days) =>
      await usageOver(
        {
          index,
          store,
          ensureIndex,
          announced: announced.get,
          invokeOf: (entryId) => {
            const found = findInvokable(catalog, entryId)
            return found.ok ? found.invoke : undefined
          },
          now: setup.now,
        },
        days,
      ),
    view,
    stop,
    summary: history.summary,
    rename: history.rename,
    archive: history.archive,
    remove: history.remove,
    search: async (query) => await searchHistory({ index, store, table, ensureIndex, uploadsRoot: uploads.root }, query),
    upload: unlessStopped(uploads.adopt),
    openUpload: uploads.locate,
    files: async (query) => await listFiles(lister, table, query),
    projects: history.projects,
    requestProject: unlessStopped(folders.requestProject),
    requestShared: unlessStopped(folders.requestShared),
    requestStatus: folders.requestStatus,
    inspectGrant: folders.inspectGrant,
    answerGrant: unlessStopped(folders.answerGrant),
    updateProject: unlessStopped(folders.updateProject),
    pinProject: unlessStopped(folders.pinProject),
    setLayout: unlessStopped(folders.setLayout),
    removeProject: unlessStopped(folders.removeProject),
    removeHistory: unlessStopped(folders.removeHistory),
    removeShared: unlessStopped(folders.removeShared),
    // Mounted HERE: the questions' tool and the services' on one server (spec 2026-10-02, D7).
    mcp: async (sessionId, message) => await handleMcp({ askOwner: questions.askOwner, services: services.mcp }, sessionId, message),
    inspectQuestions: questions.inspect,
    answerQuestions: unlessStopped(questions.answer),
    sessionQuestions: async (sessionId) => (isSessionId(sessionId) ? await questions.inSession(sessionId) : []),
    answerSessionQuestions: unlessStopped(questions.answerInSession),
    readService: async (sessionId, id, lines) => (isSessionId(sessionId) ? await services.table.read(sessionId, id, lines) : undefined),
    stopService: unlessStopped(async (sessionId, id) => (isSessionId(sessionId) ? await services.table.stop(sessionId, id, 'owner') : undefined)),
  }
}
