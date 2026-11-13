/**
 * The generation queue over `claude -p` (tasks G2a–G4, design D10), on the `work` table: it survives
 * a restart.
 *
 * LANES: `interactive` (rewrites, classifying replies, a pasted link) goes before `bulk` (the seed's
 * CVs, the scout, the keeper). `concurrency` runs in total, and when a slot frees up an interactive
 * waiting takes it: interactive first, always. With `concurrency > 1`, `bulk` takes at most
 * `concurrency − 1` slots, so an interactive never waits for a CV to finish (D10, 13-nov). Within a lane the pump CHAINS WORKS OF THE SAME KIND
 * (all the `cv`, then the `verify`): each kind is its own prompt cache, and the cache lives 5 min (A4).
 * `reprint` runs no Claude: it takes no slot, and only one runs at a time.
 *
 * THE PUMP runs on `add` and on every tick (D16), NEVER inside a `tx`: `enqueue` is the piece a caller
 * puts in its own `tx`, and it pumps after. Each run is marked `running` in a `tx` of its own, runs
 * outside any (the handler: Claude, the PDF), and its return is written in another.
 *
 * WHAT A WORK DOES IS ITS HANDLER'S (`handlers[kind]`, injected: H5a/H5b, the verifier, the scout…):
 * it gets the row, an abort signal and the timeout of its kind, and answers a `JobResult` — never
 * throws past here (a throw is a failed run).
 */

import type { Logger } from '@factotum/core'
import { uuidv7 } from '@factotum/sessions'
import { appTransition, type GeneratedKind } from '../state.ts'
import type { Db, Queries } from '../store/db.ts'
import {
  dueWork,
  getApplication,
  getMeta,
  insertWork,
  saveApplication,
  saveWork,
  setGenRequest,
  type Lane,
  type Work,
  type WorkKind,
} from '../store/repo.ts'
import { fail, ok, type Application, type Artifacts, type Followup, type FollowupVersion, type Result, type Warning } from '../types.ts'
import { classesOf, markNotWritten, PAUSED_UNTIL, returnNotWritten, writeReturn, type RewriteFailed } from './returns.ts'
import type { RunFailure } from './run.ts'

export type { Lane, Work, WorkKind } from '../store/repo.ts'
export {
  classesOf,
  instructionEvent,
  LIMIT_PAUSE_MS,
  LIMIT_STREAK_MAX,
  MAX_ATTEMPTS,
  PAUSED_UNTIL,
  RETRY_DELAYS_MS,
  type InstructionEventData,
  type RewriteFailed,
} from './returns.ts'

/** design D10 «Timeouts», by kind. `reprint` and `score` are not Claude writing: a minute. */
export const TIMEOUT_MS: Readonly<Record<WorkKind, number>> = {
  cv: 180_000,
  letter: 120_000,
  rewrite: 120_000,
  verify: 120_000,
  classify: 60_000,
  extract: 60_000,
  score: 60_000,
  keeper: 300_000,
  reprint: 60_000,
}

/** design D10 «Carriles»: what the owner is waiting for is interactive. */
const INTERACTIVE_KINDS: ReadonlySet<WorkKind> = new Set<WorkKind>(['rewrite', 'classify', 'extract'])
export const defaultLane = (kind: WorkKind): Lane => (INTERACTIVE_KINDS.has(kind) ? 'interactive' : 'bulk')

/** What a generation brought back for an application: the fields it produced, the rest stays (G4). */
export type ArtifactsPatch = Partial<Pick<Artifacts, 'cv' | 'pdf' | 'png' | 'contactHash' | 'letter' | 'form' | 'skills' | 'linkedin'>> &
  Pick<Artifacts, 'profileVersion' | 'rules' | 'usage' | 'origin'>

export type JobOutput =
  /**
   * A new version of the application's artifacts (cv, letter, rewrite, reprint). `warnings`: what the
   * handler found that no linter can see — the verifier's `unsupported-claim`, `cv-overflow` (D5 steps
   * 7–8) — added to the linter's at the return. ABSENT means «nothing was verified»: the found
   * warnings the application carries all stay (D15); `[]` means «verified, and clean» for the texts
   * the patch brings (`cv`, `letter`).
   */
  | { readonly type: 'application'; readonly artifacts: ArtifactsPatch; readonly warnings?: readonly Warning[] }
  /** A new version of a follow-up (its `rewrite`). */
  | { readonly type: 'followup'; readonly version: Omit<FollowupVersion, 'version' | 'origin' | 'instruction'> }
  /** Anything else (verify, classify, score…): written by the handler's own function, in the queue's `tx`. */
  | { readonly type: 'apply'; readonly apply: (q: Queries, now: Date) => Result<void> }

export type JobResult = { readonly ok: true; readonly output: JobOutput } | RunFailure

export interface JobContext {
  /** Aborted by `stop()`: the handler hands it to `runClaude`, which kills the group. */
  readonly signal: AbortSignal
  readonly timeoutMs: number
}

export type JobHandler = (work: Work, ctx: JobContext) => Promise<JobResult>

/** What a returned generation is linted with: L1, injected (H4). */
export type LintTarget =
  | { readonly kind: 'application'; readonly application: Application; readonly artifacts: Artifacts }
  | { readonly kind: 'followup'; readonly followup: Followup; readonly version: FollowupVersion }
export type LintFn = (q: Queries, target: LintTarget, now: Date) => readonly Warning[]
/** Re-lints one entity in `in-review`/`ready` (or a follow-up `draft`/`ready`) and writes it: L4, injected. */
export type RelintFn = (q: Queries, entity: { readonly kind: 'application' | 'followup'; readonly id: string }, now: Date) => Result<void>

export interface QueueDeps {
  readonly db: Db
  readonly now: () => Date
  /** `claude.concurrency` (2). */
  readonly concurrency: number
  readonly handlers: Readonly<Partial<Record<WorkKind, JobHandler>>>
  readonly log: Logger
  readonly lint: LintFn
  readonly relintOne: RelintFn
  /** Whether the printed CV is on disk (T-A2); `existsSync` in production. */
  readonly pdfExists: (path: string) => boolean
  /** A rewrite failed for good (T-A9, T-F5): the batch puts it at its end (D15). After the `tx`. */
  readonly onRewriteFailed?: ((entity: RewriteFailed) => void) | undefined
}

export interface EnqueueSpec {
  readonly kind: WorkKind
  readonly ref: string
  /** By kind when absent (`defaultLane`). */
  readonly lane?: Lane
}

export interface Queue {
  /** Writes the work row, inside the caller's `tx`. The caller pumps after its `tx` (`pump`). */
  readonly enqueue: (q: Queries, spec: EnqueueSpec) => Result<Work>
  /** The seed's seam (S6): T-A1 — `draft → generating`, `gen_requests(id, 'cv')`, a bulk `cv`. Inside the caller's `tx`. */
  readonly enqueueCv: (q: Queries, applicationId: string) => Result<void>
  /**
   * «Retry» of `missing-cv`/`missing-letter` (T-A4): a new request of ONLY the classes that failed,
   * interactive, and the application back to `generating`. Inside the caller's `tx`; pump after.
   */
  readonly retry: (q: Queries, applicationId: string) => Result<readonly GeneratedKind[]>
  /** `enqueue` in a `tx` of its own, then the pump. */
  readonly add: (spec: EnqueueSpec) => Result<Work>
  /** `meta.pausedUntil` while a usage limit holds the queue (for `health()`); null when it runs. */
  readonly pausedUntil: () => string | null
  /** Starts what can start. Never inside a `tx`; never throws. */
  readonly pump: () => void
  /** The ids running now, in the order they started. */
  readonly running: () => readonly string[]
  /** Resolves when nothing is running (what was started meanwhile included). */
  readonly settled: () => Promise<void>
  /**
   * Aborts every run (their groups are killed) and waits for them (R7, R27). A stopped run writes
   * NOTHING: its row stays `running`, and the next start's opening write (`recoverOnStart`) puts it
   * back in the queue. After `stop` the queue starts nothing and `add` is refused.
   */
  readonly stop: () => Promise<void>
}

const MISSING_KIND: Readonly<Partial<Record<Warning['code'], GeneratedKind>>> = { 'missing-cv': 'cv', 'missing-letter': 'letter' }
const GENERATED_ORDER: readonly GeneratedKind[] = ['cv', 'letter']

interface Running {
  readonly work: Work
  readonly controller: AbortController
  readonly done: Promise<void>
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Interactive first; within a lane, the kind that ran last first; then the oldest. */
function byPriority(lastKind: WorkKind | null): (a: Work, b: Work) => number {
  const rank = (work: Work): number => (work.lane === 'interactive' ? 0 : 2) + (work.kind === lastKind ? 0 : 1)
  return (a, b) => rank(a) - rank(b)
}

export function createQueue(deps: QueueDeps): Queue {
  const { db, now, log } = deps
  const inFlight = new Map<string, Running>()
  let lastKind: WorkKind | null = null
  let stopped = false

  function enqueue(q: Queries, spec: EnqueueSpec): Result<Work> {
    const at = now().toISOString()
    const work: Work = {
      id: uuidv7(now().getTime()),
      kind: spec.kind,
      ref: spec.ref,
      lane: spec.lane ?? defaultLane(spec.kind),
      state: 'queued',
      attempts: 0,
      notBefore: null,
      reason: null,
      createdAt: at,
      updatedAt: at,
    }
    insertWork(q, work)
    for (const kind of classesOf(q, spec.kind, spec.ref)) setGenRequest(q, spec.ref, kind, work.id)
    return ok(Object.freeze(work))
  }

  function enqueueCv(q: Queries, applicationId: string): Result<void> {
    const app = getApplication(q, applicationId)
    if (app === undefined) return fail('not-found', 'no such application')
    const moved = appTransition(app, { type: 'enqueue' }, now()) // T-A1
    if (!moved.ok) return moved
    const work = enqueue(q, { kind: 'cv', ref: applicationId, lane: 'bulk' })
    if (!work.ok) return work
    return saveApplication(q, moved.value, { kind: 'prepared', data: { queued: ['cv'], workId: work.value.id } }, now())
  }

  function retry(q: Queries, applicationId: string): Result<readonly GeneratedKind[]> {
    const app = getApplication(q, applicationId)
    if (app === undefined) return fail('not-found', 'no such application')
    const failed = new Set(app.warnings.map((w) => MISSING_KIND[w.code]))
    const kinds = GENERATED_ORDER.filter((kind) => failed.has(kind))
    if (kinds.length === 0) return fail('conflict', 'no generation of this application failed')
    const moved = appTransition(app, { type: 'retry-generation', kinds }, now()) // T-A4
    if (!moved.ok) return moved
    for (const kind of kinds) enqueue(q, { kind, ref: applicationId, lane: 'interactive' })
    const saved = saveApplication(q, moved.value, { kind: 'retried', data: { kinds } }, now())
    return saved.ok ? ok(kinds) : saved
  }

  const claudeRuns = (): readonly Work[] => [...inFlight.values()].map((r) => r.work).filter((work) => work.kind !== 'reprint')
  const printing = (): boolean => [...inFlight.values()].some((r) => r.work.kind === 'reprint')

  /** Claude slots now: none while paused, ONE for the probe once the pause ran out (D10), else all. */
  function claudeSlots(q: Queries, at: string): number {
    const until = getMeta(q, PAUSED_UNTIL)
    if (until === undefined) return deps.concurrency
    return until > at ? 0 : 1
  }

  /** D10: with more than one slot, `bulk` leaves one free for `interactive`; with one, it may take it. */
  const bulkSlots = (slots: number): number => (slots > 1 ? slots - 1 : slots)

  function canStartClaude(work: Work, slots: number): boolean {
    const runs = claudeRuns()
    if (runs.length >= slots) return false
    return work.lane === 'interactive' || runs.filter((run) => run.lane === 'bulk').length < bulkSlots(slots)
  }

  function next(): Work | undefined {
    const at = now().toISOString()
    const { due, slots } = db.read((q) => ({ due: dueWork(q, at), slots: claudeSlots(q, at) }))
    const canStart = (work: Work): boolean => (work.kind === 'reprint' ? !printing() : canStartClaude(work, slots))
    return due
      .filter((work) => !inFlight.has(work.id))
      .sort(byPriority(lastKind))
      .find(canStart)
  }

  /** Marks it running in its own `tx`, then runs it outside any. */
  function start(work: Work): boolean {
    const at = now().toISOString()
    const running: Work = { ...work, state: 'running', updatedAt: at }
    const marked = db.tx((q) => saveWork(q, running))
    if (!marked.ok) {
      log.error(`jobs queue: ${work.kind} ${work.id} could not start (${marked.error.reason})`)
      return false
    }
    const controller = new AbortController()
    const done = execute(running, controller.signal)
      .then((result) => conclude(running, result))
      .catch((error: unknown) => concludeThrew(running, error))
    inFlight.set(work.id, { work: running, controller, done })
    lastKind = work.kind
    return true
  }

  async function execute(work: Work, signal: AbortSignal): Promise<JobResult> {
    const handler = deps.handlers[work.kind]
    if (handler === undefined) return { ok: false, kind: 'failed', reason: `no handler for ${work.kind}` }
    try {
      return await handler(work, { signal, timeoutMs: TIMEOUT_MS[work.kind] })
    } catch (error) {
      return { ok: false, kind: 'failed', reason: `the ${work.kind} handler threw: ${messageOf(error)}` }
    }
  }

  /** Writes what came back, in its own `tx`, tells the batch, and pumps again. */
  function conclude(work: Work, result: JobResult): void {
    inFlight.delete(work.id)
    if (stopped) return
    const written = db.tx((q) => writeReturn(q, work, result, deps, now()))
    if (written.ok) {
      if (written.value.warning !== null) log.warn(`jobs queue: ${written.value.warning}`)
      if (written.value.rewriteFailed !== null) tell(written.value.rewriteFailed)
    } else {
      notWritten(work, written.error.reason)
    }
    pump()
  }

  /**
   * The return's `tx` rolled back, `done` with it: the run goes through the failure path in a second,
   * small `tx` (an attempt, its retry, an event), or — when that rolls back too — the row alone.
   */
  function notWritten(work: Work, reason: string): void {
    const failed = db.tx((q) => returnNotWritten(q, work, deps, now()))
    const marked = failed.ok ? failed : db.tx((q) => markNotWritten(q, work, now()))
    const outcome = failed.ok ? 'counted as a failed attempt' : marked.ok ? `counted as a failed attempt, without its entity (${failed.error.reason})` : `and the work could not be marked either (${marked.error.reason})`
    if (failed.ok && failed.value.rewriteFailed !== null) tell(failed.value.rewriteFailed)
    log.error(`jobs queue: the return of ${work.kind} ${work.id} could not be written (${reason}); ${outcome}`)
  }

  /** `conclude` itself threw (a logger, a seam): said if it can be, and the queue goes on. */
  function concludeThrew(work: Work, error: unknown): void {
    inFlight.delete(work.id)
    try {
      log.error(`jobs queue: concluding ${work.kind} ${work.id} failed (${messageOf(error)})`)
    } catch {
      // A logger that throws has nowhere left to say so; the pump below must still run.
    }
    pump()
  }

  function tell(entity: RewriteFailed): void {
    try {
      deps.onRewriteFailed?.(entity)
    } catch (error) {
      log.error(`jobs queue: the batch was not told of a failed rewrite (${messageOf(error)})`)
    }
  }

  function pump(): void {
    if (stopped) return
    try {
      for (let work = next(); work !== undefined && start(work); work = next()) {
        // `start` took it; look for the next.
      }
    } catch (error) {
      log.error(`jobs queue: the pump failed (${messageOf(error)})`)
    }
  }

  async function settled(): Promise<void> {
    while (inFlight.size > 0) await Promise.all([...inFlight.values()].map((r) => r.done))
  }

  return {
    enqueue,
    enqueueCv,
    retry,
    add: (spec) => {
      if (stopped) return fail('conflict', 'the generation queue is stopped')
      const added = db.tx((q) => enqueue(q, spec))
      if (added.ok) pump()
      return added
    },
    pump,
    running: () => [...inFlight.keys()],
    settled,
    stop: async () => {
      stopped = true
      for (const run of inFlight.values()) run.controller.abort()
      await settled()
    },
    pausedUntil: () => db.read((q) => getMeta(q, PAUSED_UNTIL)) ?? null,
  }
}
