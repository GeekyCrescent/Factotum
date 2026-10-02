/**
 * The live services, in memory (spec 2026-10-02-servicios-en-segundo-plano, D5). THE ONLY PLACE THAT WRITES
 * `service ended`.
 *
 * ONE END, ONCE, AND THE `ended` IS WRITTEN WHEN FACTOTUM DECIDES, NOT WHEN THE PROCESS DIES (criteria 21,
 * 32). Whoever decides first — a natural exit, Stop, the timer, Cancel, a delete, `stop()` — fixes the
 * outcome, QUEUES the `ended` in that same tick and sends the signal; everybody after gets the same entry.
 * That is what puts a Cancel's `ended`s before the session's `cancelled`: `finalize` is launched by the
 * CLI's death, not by `cancel()`, so waiting for a service to die (up to KILL_GRACE_MS) would land them
 * after it. Queued first, the store's per-session chain keeps the order — the same move as `closeQuestions`.
 * The outcome of a service Factotum killed is whoever killed it, NEVER deduced from the exit code (the
 * engine's `entry.cancelled` rule).
 *
 * `start` IS ATOMIC (criterion 43). The entry exists BEFORE the first `await`, and every `await` is followed
 * by a check:
 *   0. sync: refused if the session is `closing` or everything stopped; otherwise an entry, `reserved`.
 *   1. the cwd check and the id counter, in parallel (the counter is read once per session, shared).
 *   2. sync: decided while waiting → dropped, NOTHING written: no id, no process, no row to close.
 *   3. output and launch.            4. registry, then `started` queued.
 *   5. decided meanwhile → its `ended` is queued AFTER the `started`, and the group is killed.
 *   6. the max timer, and the startup grace raced against the exit.
 * `pending(sessionId)` is the promise that every entry of the session in steps 0-5 has queued its writes;
 * `finalize` awaits it before the terminal state, which is what orders an interrupted start before
 * `cancelled`.
 *
 * WHAT ENDED IS NOT HERE: `read`, `stop` and `list` fall back to the log (`history.ts`, criterion 39).
 * A service takes no lock (criterion 23).
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger, Timers } from '@factotum/core'
import { clip } from '../parse.ts'
import type { SessionPaths } from '../paths.ts'
import type { EventInput, SessionEvent } from '../types.ts'
import { servicesFromLog } from './history.ts'
import { openOutput, tail, type OutputFile } from './output.ts'
import type { ServiceRegistry } from './registry.ts'
import {
  DEFAULT_LINES,
  MAX_LOGGED_COMMAND_CHARS,
  STARTUP_GRACE_MS,
  type ServiceOutcome,
  type ServiceView,
  type StartRequest,
  type StoppedBy,
} from './shape.ts'
import { spawnService, type SpawnInput, type SpawnedService } from './spawn.ts'

export const CANCELLED_START = 'The session was cancelled before the service could start. Nothing was launched.'
export const SHUTDOWN_START = 'Factotum is stopping; no service can start now.'
export const UNRECORDED = 'could not record the service'
export const STOPPED_WHILE_STARTING = 'The service was stopped while it was starting'

export interface ServiceTableDeps {
  /** Arrows, never `store.append` loose: the store is a class with `#` fields. */
  readonly append: (sessionId: string, event: EventInput) => Promise<unknown>
  /** The session's log: for the id counter and for what ended (D5 bis). */
  readonly events: (sessionId: string) => Promise<readonly SessionEvent[]>
  readonly registry: ServiceRegistry
  readonly paths: SessionPaths
  /** The argv prefix the command is appended to (D3). */
  readonly shell: readonly string[]
  readonly timers: Timers
  readonly now: () => Date
  readonly log: Logger
  /** Seams: a test fires every exit and holds the cwd check. */
  readonly spawn?: (input: SpawnInput) => SpawnedService
  readonly isDirectory?: (path: string) => Promise<boolean>
}

export type StartOutcome =
  | { readonly kind: 'started'; readonly view: ServiceView }
  | { readonly kind: 'exited-early'; readonly view: ServiceView; readonly lines: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: string }

export interface ServiceTable {
  readonly start: (sessionId: string, request: StartRequest, task: string | undefined) => Promise<StartOutcome>
  readonly read: (sessionId: string, id: string, lines: number) => Promise<{ view: ServiceView; lines: readonly string[] } | undefined>
  readonly stop: (sessionId: string, id: string, by: StoppedBy) => Promise<ServiceView | undefined>
  readonly list: (sessionId: string) => Promise<readonly ServiceView[]>
  /**
   * Cancel and delete. SYNCHRONOUS UP TO THE QUEUEING: marks the session `closing`, fixes each live entry's
   * outcome, QUEUES its `ended` in the same tick and signals it. The promise is the writes AND the deaths
   * (at most KILL_GRACE_MS: here there is a SIGKILL rescue).
   */
  readonly stopSession: (sessionId: string, outcome: 'cancelled' | 'stopped') => Promise<void>
  /** Takes the session out of `closing`. The engine calls it when it launches a turn (`spawnFor`). */
  readonly reopen: (sessionId: string) => void
  /** The session's entries in steps 0-5 have queued their writes. At once when it has none. */
  readonly pending: (sessionId: string) => Promise<void>
  /**
   * `stop()` of the engine: SIGTERM with no rescue, `ended` queued as `shutdown`. Does NOT touch the registry
   * (guardrail 8). The promise is the WRITES, never the deaths (criterion 44), and it covers the starts half
   * way in every session. After it, `start` is refused without launching anything.
   */
  readonly stopAll: (reason: string) => Promise<void>
}

interface Decision {
  readonly outcome: ServiceOutcome
  readonly by?: StoppedBy
  readonly code?: number
  readonly signal?: string
  readonly reason?: string
  /** `undefined`: it ended by itself, nothing to signal. */
  readonly kill?: 'graceful' | 'term-only'
  /** `stopAll` leaves the registry for the next start's reconcile. */
  readonly keepRegistry?: boolean
}

interface Deferred {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((res) => (resolve = res))
  return { promise, resolve }
}

interface Entry {
  readonly sessionId: string
  phase: 'reserved' | 'live'
  id: string | undefined
  view: ServiceView | undefined
  service: SpawnedService | undefined
  output: OutputFile | undefined
  path: string | undefined
  timer: Disposable | undefined
  decision: Decision | undefined
  /** The `ended` is queued. `settle` runs once whoever calls it: step 5 and `decide` can both reach it. */
  settled: boolean
  /** Steps 0-5 done: its writes are queued, or it was dropped. What `pending` waits for. */
  readonly queued: Deferred
  /** Its `ended` is written (or it was dropped with nothing to write). */
  readonly ended: Deferred
  /** Dead and cleaned up (or dropped). */
  readonly gone: Deferred
}

const message = (error: unknown): string => (error instanceof Error ? error.message : 'error')

async function isDirectoryDefault(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export function createServiceTable(deps: ServiceTableDeps): ServiceTable {
  const spawn = deps.spawn ?? spawnService
  const isDirectory = deps.isDirectory ?? isDirectoryDefault
  const entries = new Set<Entry>()
  const closing = new Set<string>()
  /** Per session, the NEXT number. A promise, so two concurrent starts share one read of the log. */
  const counters = new Map<string, Promise<{ next: number }>>()
  let stoppedAll = false

  const of = (sessionId: string): Entry[] => [...entries].filter((entry) => entry.sessionId === sessionId)
  const outputPath = (sessionId: string, id: string): string => join(deps.paths.servicesDir(sessionId), `${id}.log`)

  function counter(sessionId: string): Promise<{ next: number }> {
    const known = counters.get(sessionId)
    if (known !== undefined) return known
    const reading = deps.events(sessionId).then((events) => {
      const numbers = events.flatMap((e) => (e.kind === 'service' && e.phase === 'started' && /^s\d+$/.test(e.id) ? [Number(e.id.slice(1))] : []))
      return { next: Math.max(0, ...numbers) + 1 }
    })
    counters.set(sessionId, reading)
    // A failed read is not cached: the next start tries again.
    reading.catch(() => counters.delete(sessionId))
    return reading
  }

  /** Never rejects: a lost line is warned, without content (criterion 30). */
  function write(sessionId: string, event: EventInput): Promise<void> {
    return deps
      .append(sessionId, event)
      .then(() => undefined)
      .catch((error: unknown) => deps.log.warn(`a service event of session ${sessionId} could not be written: ${message(error)}`))
  }

  function drop(entry: Entry): void {
    entries.delete(entry)
    entry.queued.resolve()
    entry.ended.resolve()
    entry.gone.resolve()
  }

  /** The decision is taken: queue the `ended` NOW, then signal. Only for an entry with a process. */
  function settle(entry: Entry): void {
    const { decision, view, service } = entry
    if (entry.settled || decision === undefined || view === undefined || service === undefined) return
    entry.settled = true
    entry.timer?.[Symbol.dispose]()
    const endedAt = deps.now().toISOString()
    const event: EventInput = {
      kind: 'service',
      phase: 'ended',
      id: view.id,
      outcome: decision.outcome,
      ...(decision.by === undefined ? {} : { by: decision.by }),
      ...(decision.code === undefined ? {} : { code: decision.code }),
      ...(decision.signal === undefined ? {} : { signal: decision.signal }),
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    }
    void write(entry.sessionId, event).then(entry.ended.resolve)
    entry.view = { ...view, state: decision.outcome, endedAt, by: decision.by, code: decision.code, signal: decision.signal, reason: decision.reason }
    if (decision.kill !== undefined) service.kill(decision.kill === 'graceful')
  }

  /** The first decision wins. A `reserved` entry keeps it until `start` reaches step 2 or 5. */
  function decide(entry: Entry, decision: Decision): void {
    if (entry.decision !== undefined) return
    entry.decision = decision
    if (entry.phase === 'live') settle(entry)
    // Still before its id (step 1): step 2 will drop it with nothing to write, so nobody waits for that.
    // Otherwise a hung cwd check or log read would hold `stop()` and `finalize` (review, 2026-10-02).
    else if (entry.id === undefined) {
      entry.queued.resolve()
      entry.ended.resolve()
      entry.gone.resolve()
    }
  }

  /** After the death: the output closed, out of the registry (unless `stopAll`), out of memory. */
  function onDeath(entry: Entry, service: SpawnedService): void {
    void service.done
      .then(async (exit) => {
        decide(entry, {
          outcome: exit.code === 0 ? 'exited' : 'failed',
          ...(exit.code === null ? {} : { code: exit.code }),
          ...(exit.signal === null ? {} : { signal: exit.signal }),
        })
        await service.drained
        await entry.output?.close()
        if (entry.decision?.keepRegistry !== true && entry.id !== undefined) await deps.registry.remove(entry.sessionId, entry.id)
      })
      .catch((error: unknown) => deps.log.warn(`service ${entry.id ?? '?'} of session ${entry.sessionId} could not be cleaned up: ${message(error)}`))
      .finally(() => {
        entries.delete(entry)
        entry.gone.resolve()
      })
  }

  /** Steps 1-5. Returns the entry live, or a refusal with the entry already dropped. */
  async function launch(entry: Entry, request: StartRequest, task: string | undefined): Promise<{ kind: 'refused'; reason: string } | undefined> {
    const { sessionId } = entry
    // 1.
    let next: { next: number }
    let isDir: boolean
    try {
      ;[isDir, next] = await Promise.all([isDirectory(request.cwd), counter(sessionId)])
    } catch (error) {
      drop(entry)
      return { kind: 'refused', reason: `factotum could not read this session's log: ${message(error)}` }
    }
    // 2.
    if (entry.decision !== undefined) {
      drop(entry)
      return { kind: 'refused', reason: entry.decision.outcome === 'shutdown' ? SHUTDOWN_START : CANCELLED_START }
    }
    if (!isDir) {
      drop(entry)
      return { kind: 'refused', reason: `The working directory ${request.cwd} does not exist or is not a directory. Pass an existing cwd.` }
    }
    const id = `s${next.next}`
    next.next += 1
    entry.id = id

    // 3.
    const path = outputPath(sessionId, id)
    const output = openOutput(path, deps.log)
    let service: SpawnedService
    try {
      service = spawn({ command: request.command, cwd: request.cwd, shell: deps.shell, onOutput: output.write, timers: deps.timers })
    } catch (error) {
      void output.close()
      drop(entry)
      return { kind: 'refused', reason: `The service could not be launched: ${message(error)}` }
    }
    entry.service = service
    entry.output = output
    entry.path = path
    const startedAt = deps.now().toISOString()
    const command = clip(request.command, MAX_LOGGED_COMMAND_CHARS)
    entry.view = {
      id,
      command,
      description: request.description,
      cwd: request.cwd,
      pid: service.pid,
      maxMinutes: request.maxMinutes,
      startedAt,
      task,
      state: 'running',
      endedAt: undefined,
      by: undefined,
      code: undefined,
      signal: undefined,
      reason: undefined,
    }
    onDeath(entry, service)

    // 4.
    let recorded = true
    try {
      await deps.registry.add({ sessionId, id, pid: service.pid, startedAt })
    } catch (error) {
      recorded = false
      deps.log.warn(`service ${id} of session ${sessionId} could not be recorded, so it was stopped: ${message(error)}`)
    }
    void write(sessionId, {
      kind: 'service',
      phase: 'started',
      id,
      command,
      ...(request.description === undefined ? {} : { description: request.description }),
      cwd: request.cwd,
      maxMinutes: request.maxMinutes,
      pid: service.pid,
      ...(task === undefined ? {} : { task }),
    })
    entry.phase = 'live'
    // A process the reconcile would never find is not left alive.
    if (!recorded) decide(entry, { outcome: 'failed', reason: UNRECORDED, kill: 'graceful' })
    // 5. A decision taken while this was waiting: its `ended` goes AFTER the `started` just queued.
    settle(entry)
    entry.queued.resolve()
    return recorded ? undefined : { kind: 'refused', reason: 'factotum could not record the service, so it stopped it. Try again.' }
  }

  async function start(sessionId: string, request: StartRequest, task: string | undefined): Promise<StartOutcome> {
    // 0. Synchronous: from here on, stopSession, stopAll and pending see the entry.
    if (stoppedAll) return { kind: 'refused', reason: SHUTDOWN_START }
    if (closing.has(sessionId)) return { kind: 'refused', reason: CANCELLED_START }
    const entry: Entry = {
      sessionId,
      phase: 'reserved',
      id: undefined,
      view: undefined,
      service: undefined,
      output: undefined,
      path: undefined,
      timer: undefined,
      decision: undefined,
      settled: false,
      queued: deferred(),
      ended: deferred(),
      gone: deferred(),
    }
    entries.add(entry)

    const refused = await launch(entry, request, task)
    if (refused !== undefined) return refused
    const service = entry.service as SpawnedService
    // Factotum stopped it before the agent heard back (a Cancel, stop()): never answered as "started".
    const stoppedEarly = (): StartOutcome | undefined =>
      entry.decision?.kill === undefined
        ? undefined
        : { kind: 'refused', reason: `${STOPPED_WHILE_STARTING} (${entry.decision.outcome}); it is not running.` }
    const early = stoppedEarly()
    if (early !== undefined) return early

    // 6.
    if (entry.decision === undefined) {
      entry.timer = deps.timers.setTimeout(
        () => decide(entry, { outcome: 'timeout', kill: 'graceful' }),
        request.maxMinutes * 60_000,
      )
    }
    let grace: Disposable | undefined
    const exitedEarly = await Promise.race([
      new Promise<false>((resolve) => (grace = deps.timers.setTimeout(() => resolve(false), STARTUP_GRACE_MS))),
      service.done.then(() => true as const),
    ])
    grace?.[Symbol.dispose]()
    if (!exitedEarly) return stoppedEarly() ?? { kind: 'started', view: entry.view as ServiceView }

    // Exit can beat the last `data`: drained, then flushed, then read (D3, D4).
    await service.drained
    await entry.output?.flush()
    const lines = await tail(entry.path as string, DEFAULT_LINES)
    return { kind: 'exited-early', view: entry.view as ServiceView, lines }
  }

  const live = (sessionId: string, id: string): Entry | undefined => of(sessionId).find((entry) => entry.id === id)

  async function fromLog(sessionId: string, id: string): Promise<ServiceView | undefined> {
    return servicesFromLog(await deps.events(sessionId)).find((view) => view.id === id)
  }

  return {
    start,

    read: async (sessionId, id, lines) => {
      const entry = live(sessionId, id)
      if (entry?.view !== undefined) {
        await entry.output?.flush()
        return { view: entry.view, lines: await tail(outputPath(sessionId, id), lines) }
      }
      const view = await fromLog(sessionId, id)
      if (view === undefined) return undefined
      return { view, lines: await tail(outputPath(sessionId, id), lines) }
    },

    stop: async (sessionId, id, by) => {
      const entry = live(sessionId, id)
      if (entry === undefined) return await fromLog(sessionId, id)
      decide(entry, { outcome: 'stopped', by, kill: 'graceful' })
      await entry.ended.promise
      return entry.view
    },

    list: async (sessionId) => {
      const memory = new Map(of(sessionId).flatMap((entry) => (entry.view === undefined ? [] : [[entry.view.id, entry.view] as const])))
      return servicesFromLog(await deps.events(sessionId)).map((view) => memory.get(view.id) ?? view)
    },

    stopSession: (sessionId, outcome) => {
      closing.add(sessionId)
      const mine = of(sessionId)
      for (const entry of mine) decide(entry, { outcome, ...(outcome === 'stopped' ? { by: 'owner' as const } : {}), kill: 'graceful' })
      return Promise.all(mine.map(async (entry) => await Promise.all([entry.queued.promise, entry.ended.promise, entry.gone.promise]))).then(() => undefined)
    },

    reopen: (sessionId) => {
      closing.delete(sessionId)
    },

    pending: async (sessionId) => {
      const starting = of(sessionId).filter((entry) => entry.phase === 'reserved')
      if (starting.length === 0) return
      await Promise.all(starting.map((entry) => entry.queued.promise))
    },

    stopAll: (reason) => {
      stoppedAll = true
      const all = [...entries]
      for (const entry of all) decide(entry, { outcome: 'shutdown', reason, kill: 'term-only', keepRegistry: true })
      return Promise.all(all.map(async (entry) => await Promise.all([entry.queued.promise, entry.ended.promise]))).then(() => undefined)
    },
  }
}
