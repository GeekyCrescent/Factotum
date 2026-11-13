/**
 * What happens when a work comes back (tasks G2b, G4; design D10, D3 «La guarda»): written by the
 * queue in ONE `tx` with the work row, so the entity and its work never disagree. WHEN THAT `tx` ROLLS
 * BACK (a linter that throws, a refused transition) the run is a failed one (`returnNotWritten`): an
 * attempt, the retries, an event — in a second `tx`, never a work left `running`.
 *
 * A GENERATION THAT COMES BACK (cv, letter, rewrite, reprint) is saved as a NEW VERSION ALWAYS, the
 * fields it did not produce taken from the current version, whatever state the entity is in now. The
 * transition is applied only from `generating` (T-A2, and only once NO request of its own is still
 * queued or running) or `rewriting` (T-A8, T-F4); anywhere else (`closed`, `sent`…) the version is kept
 * and the state is not touched.
 *
 * A GENERATION THAT FAILS FOR THE THIRD TIME: a `cv`/`letter` takes the application out of
 * `generating` to `in-review` with the warning OF THE CLASS THAT FAILED (T-A3, v5 X8) — again only
 * once nothing of its own is pending; a `rewrite` goes back to `rewriteFrom` (T-A9, T-F5) with
 * `rewrite-failed { instruction, reason }`, the WHOLE instruction so it is not lost; a `reprint`
 * leaves `reprint-failed { reason }` (D3, `cv-stale`).
 *
 * THE INSTRUCTION of a rewrite is read from the entity's last `instruction` event (`data.instruction`,
 * with `data.followupId` for a follow-up): the review writes it with T-A7/T-F3 THROUGH
 * `instructionEvent` (the shape is `InstructionEventData`), and `work` has no column for it.
 */

import { appTransition, followupTransition, type GeneratedKind } from '../state.ts'
import type { Queries } from '../store/db.ts'
import {
  appendEvent,
  deleteMeta,
  eventsOf,
  genRequestsOf,
  getApplication,
  getArtifacts,
  getFollowup,
  getMeta,
  getWork,
  insertArtifacts,
  saveApplication,
  saveFollowup,
  saveWork,
  setMeta,
  type EventSpec,
  type GenRequestKind,
  type Work,
  type WorkKind,
} from '../store/repo.ts'
import { fail, ok, type Application, type Artifacts, type Followup, type Result } from '../types.ts'
import type { ArtifactsPatch, JobOutput, JobResult, LintFn, RelintFn } from './queue.ts'
import type { RunFailure } from './run.ts'

export interface ReturnDeps {
  readonly lint: LintFn
  readonly relintOne: RelintFn
  readonly pdfExists: (path: string) => boolean
}

/** An entity whose rewrite failed for good, for the batch (D15: «rewrite failed» at its end). */
export interface RewriteFailed {
  readonly kind: 'application' | 'followup'
  readonly id: string
}

/** What a failure written here asks the queue to do after its `tx`. */
export interface Aftermath {
  readonly rewriteFailed: RewriteFailed | null
  /** Something the queue should log (warn): never a word of the prompt or the answer. */
  readonly warning: string | null
}

const NOTHING: Aftermath = { rewriteFailed: null, warning: null }

/** The version an application had before any generation: nothing but its profile. */
const EMPTY: Omit<Artifacts, 'version'> = {
  cv: null,
  pdf: null,
  png: null,
  contactHash: null,
  letter: null,
  form: [],
  skills: null,
  linkedin: null,
  profileVersion: 0,
  rules: [],
  usage: null,
  origin: 'generated',
}

const GENERATED: ReadonlySet<string> = new Set(['cv', 'letter'])

/**
 * The classes a work writes in `gen_requests` (D3 «La guarda»): a `rewrite` of an application
 * brings back the letter AND the CV; a follow-up's, its own text.
 */
export function classesOf(q: Queries, kind: WorkKind, ref: string): readonly GenRequestKind[] {
  if (kind === 'cv' || kind === 'reprint') return ['cv']
  if (kind === 'letter') return ['letter']
  if (kind === 'rewrite') return getFollowup(q, ref) === undefined ? ['letter', 'cv'] : ['followup']
  return []
}

/**
 * THE GUARD (D3, v4 A5): BY REQUEST OF THE SAME CLASS, NOT BY STATE. Some class of this work now
 * points to ANOTHER work — a newer request of that class overtook it. A request of another class does
 * not: a letter and a CV asked together both come back and both are kept.
 */
function superseded(q: Queries, work: Work): boolean {
  const classes = new Set(classesOf(q, work.kind, work.ref))
  return genRequestsOf(q, work.ref).some((r) => classes.has(r.kind) && r.workId !== work.id)
}

/** The application a work's entity belongs to (itself, or a follow-up's). */
function applicationOfRef(q: Queries, ref: string): Application | undefined {
  const row = getFollowup(q, ref)
  return getApplication(q, row?.applicationId ?? ref)
}

function discard(q: Queries, work: Work, now: Date): Result<void> {
  const app = applicationOfRef(q, work.ref)
  if (app === undefined) return ok(undefined)
  const followupId = app.id === work.ref ? {} : { followupId: work.ref }
  appendEvent(q, { kind: 'prepared', data: { discarded: true, kind: work.kind, workId: work.id, ...followupId }, applicationId: app.id, companyId: app.companyId }, now)
  return ok(undefined)
}

const REVIEWED: ReadonlySet<string> = new Set(['in-review', 'ready'])
const FOLLOWUP_REVIEWED: ReadonlySet<string> = new Set(['draft', 'ready'])

/** Another request of this entity is still queued or running (T-A2, T-A3). */
function pendingBesides(q: Queries, entityId: string, workId: string): boolean {
  return genRequestsOf(q, entityId).some((r) => r.workId !== workId && (r.state === 'queued' || r.state === 'running'))
}

/** The classes of this application whose latest request failed for good (T-A3). */
function failedClasses(q: Queries, applicationId: string): readonly GeneratedKind[] {
  return genRequestsOf(q, applicationId)
    .filter((r) => r.state === 'failed' && GENERATED.has(r.kind))
    .map((r) => r.kind as GeneratedKind)
}

const currentArtifacts = (q: Queries, app: Application): Artifacts | undefined => getArtifacts(q, app.id, app.version)

function pdfOn(artifacts: Artifacts | undefined, deps: ReturnDeps): boolean {
  return artifacts?.pdf !== null && artifacts?.pdf !== undefined && deps.pdfExists(artifacts.pdf)
}

/** T-A2/T-A3 once nothing of its own is pending: lint what there is, and say which classes failed. */
function settleGeneration(q: Queries, app: Application, event: EventSpec, deps: ReturnDeps, now: Date): Result<void> {
  const artifacts = currentArtifacts(q, app)
  const failed = failedClasses(q, app.id)
  const warnings = artifacts === undefined ? [] : deps.lint(q, { kind: 'application', application: app, artifacts }, now)
  const moved = appTransition(app, { type: 'generation-returned', pending: false, failed, pdfExists: pdfOn(artifacts, deps), warnings, version: app.version }, now)
  if (!moved.ok) return moved
  const data = failed.length === 0 ? { ...event.data } : { ...event.data, failed: true, kinds: failed }
  return saveApplication(q, moved.value, { ...event, data }, now)
}

// ── Coming back with something ───────────────────────────────────────────────────────────────────

/** A new version of the application: what came back over the current one. */
function saveVersion(q: Queries, app: Application, patch: ArtifactsPatch, now: Date): Application {
  const current = currentArtifacts(q, app) ?? { ...EMPTY, version: app.version }
  const version = app.version + 1
  insertArtifacts(q, app.id, { ...current, ...patch, version }, now)
  return { ...app, version }
}

export function applicationReturned(q: Queries, work: Work, patch: ArtifactsPatch, deps: ReturnDeps, now: Date): Result<void> {
  const before = getApplication(q, work.ref)
  if (before === undefined) return fail('not-found', 'no such application')
  const app = saveVersion(q, before, patch, now)
  const event: EventSpec = { kind: 'prepared', data: { kind: work.kind, version: app.version, workId: work.id } }
  if (app.state === 'generating' && !pendingBesides(q, app.id, work.id)) return settleGeneration(q, app, event, deps, now)
  if (app.state === 'rewriting') {
    const artifacts = currentArtifacts(q, app)
    const warnings = artifacts === undefined ? [] : deps.lint(q, { kind: 'application', application: app, artifacts }, now)
    const moved = appTransition(app, { type: 'rewrite-returned', pdfExists: pdfOn(artifacts, deps), warnings, version: app.version }, now) // T-A8
    return moved.ok ? saveApplication(q, moved.value, { kind: 'rewritten', data: { version: app.version, workId: work.id } }, now) : moved
  }
  // Kept as a version; the state is not this return's to move — re-linted when it is reviewable (D6).
  const saved = saveApplication(q, { ...app, updatedAt: now.toISOString() }, event, now)
  if (!saved.ok || !REVIEWED.has(app.state)) return saved
  return deps.relintOne(q, { kind: 'application', id: app.id }, now)
}

export function followupReturned(q: Queries, work: Work, produced: Omit<Followup['versions'][number], 'version' | 'origin' | 'instruction'>, deps: ReturnDeps, now: Date): Result<void> {
  const row = getFollowup(q, work.ref)
  if (row === undefined) return fail('not-found', 'no such follow-up')
  const version = { ...produced, version: row.version + 1, origin: 'rewritten' as const, instruction: instructionOf(q, row.applicationId, row.id) }
  if (row.state === 'rewriting') {
    const warnings = deps.lint(q, { kind: 'followup', followup: row, version }, now)
    const moved = followupTransition(row, { type: 'rewrite-returned', version, warnings }, now) // T-F4
    return moved.ok ? saveFollowup(q, moved.value, { kind: 'rewritten', data: { version: version.version, workId: work.id } }, now) : moved
  }
  const kept = { ...row, version: version.version, versions: [...row.versions, version], updatedAt: now.toISOString() }
  const saved = saveFollowup(q, kept, { kind: 'prepared', data: { kind: work.kind, version: version.version, workId: work.id } }, now)
  if (!saved.ok || !FOLLOWUP_REVIEWED.has(row.state)) return saved
  return deps.relintOne(q, { kind: 'followup', id: row.id }, now)
}

// ── Failing for the third time ───────────────────────────────────────────────────────────────────

/**
 * The `data` of an `instruction` event (T-A7, T-F3): THE ONE SHAPE the review writes and a rewrite
 * reads back, since `work` has no column for it. A follow-up's event also carries `followupId`, which
 * `saveFollowup` adds itself — never written by hand. (A `type`, not an `interface`: it must fit
 * `EventSpec['data']`'s index signature.)
 */
export type InstructionEventData = {
  readonly instruction: string
}

/** The event to save with T-A7/T-F3 (`saveApplication`/`saveFollowup`): build it here, never inline. */
export function instructionEvent(instruction: string): { readonly kind: 'instruction'; readonly data: InstructionEventData } {
  return { kind: 'instruction', data: { instruction } }
}

/** The text of the last instruction given to this entity (T-A7, T-F3); '' when none was written. */
function instructionOf(q: Queries, applicationId: string, followupId: string | null): string {
  const given = eventsOf(q, applicationId).filter((e) => e.kind === 'instruction' && (e.data.followupId ?? null) === followupId)
  const text: unknown = (given.at(-1)?.data as Partial<InstructionEventData> | undefined)?.instruction
  return typeof text === 'string' ? text : ''
}

function generationFailed(q: Queries, work: Work, deps: ReturnDeps, now: Date): Result<Aftermath> {
  const app = getApplication(q, work.ref)
  if (app === undefined || app.state !== 'generating' || pendingBesides(q, app.id, work.id)) return ok(NOTHING)
  const settled = settleGeneration(q, app, { kind: 'prepared', data: { kind: work.kind, workId: work.id, reason: work.reason } }, deps, now)
  return settled.ok ? ok(NOTHING) : settled
}

function applicationRewriteFailed(q: Queries, app: Application, work: Work, now: Date): Result<Aftermath> {
  if (app.state !== 'rewriting') return ok(NOTHING)
  const moved = appTransition(app, { type: 'rewrite-failed' }, now) // T-A9
  if (!moved.ok) return moved
  const data = { instruction: instructionOf(q, app.id, null), reason: work.reason }
  const saved = saveApplication(q, moved.value, { kind: 'rewrite-failed', data }, now)
  return saved.ok ? ok({ rewriteFailed: { kind: 'application', id: app.id }, warning: null }) : saved
}

function followupRewriteFailed(q: Queries, row: Followup, work: Work, now: Date): Result<Aftermath> {
  if (row.state !== 'rewriting') return ok(NOTHING)
  const moved = followupTransition(row, { type: 'rewrite-failed' }, now) // T-F5
  if (!moved.ok) return moved
  const data = { instruction: instructionOf(q, row.applicationId, row.id), reason: work.reason }
  const saved = saveFollowup(q, moved.value, { kind: 'rewrite-failed', data }, now)
  return saved.ok ? ok({ rewriteFailed: { kind: 'followup', id: row.id }, warning: null }) : saved
}

function rewriteFailed(q: Queries, work: Work, now: Date): Result<Aftermath> {
  const row = getFollowup(q, work.ref)
  if (row !== undefined) return followupRewriteFailed(q, row, work, now)
  const app = getApplication(q, work.ref)
  return app === undefined ? ok(NOTHING) : applicationRewriteFailed(q, app, work, now)
}

function reprintFailed(q: Queries, work: Work, now: Date): Result<Aftermath> {
  const app = getApplication(q, work.ref)
  if (app !== undefined) appendEvent(q, { kind: 'reprint-failed', data: { reason: work.reason }, applicationId: app.id, companyId: app.companyId }, now)
  return ok(NOTHING)
}

/** The third failure of `work` (already written `failed`, with its reason). */
function workFailed(q: Queries, work: Work, deps: ReturnDeps, now: Date): Result<Aftermath> {
  if (work.kind === 'cv' || work.kind === 'letter') return generationFailed(q, work, deps, now)
  if (work.kind === 'rewrite') return rewriteFailed(q, work, now)
  if (work.kind === 'reprint') return reprintFailed(q, work, now)
  return ok(NOTHING)
}

// ── The return of a run, whatever it was ────────────────────────────────────────────────────────

/** design D10 «Reintentos»: the first failure comes back at 2 min, the second at 10, the third stays. */
export const RETRY_DELAYS_MS: readonly number[] = [2 * 60_000, 10 * 60_000]
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1
/** A limit without an hour pauses this long (D10). */
export const LIMIT_PAUSE_MS = 30 * 60_000
/**
 * A limit adds no attempt — until the same work has hit one this many times in a row: by then (≈ 3 h
 * of 30-min pauses) it is more likely an error misread as a limit, looping forever. It counts.
 */
export const LIMIT_STREAK_MAX = 6
/** `meta` key: `{ workId, count }` of the limits hit in a row by one work. */
const LIMIT_STREAK = 'limitStreak'
/** `meta` key: while it is in the future, no Claude work leaves the queue. */
export const PAUSED_UNTIL = 'pausedUntil'

/** An answer that is not a limit: the streak of limits ends; after the pause ran out, the concurrency opens. */
function liftPause(q: Queries, work: Work, now: Date): void {
  if (work.kind === 'reprint') return
  deleteMeta(q, LIMIT_STREAK)
  const until = getMeta(q, PAUSED_UNTIL)
  if (until !== undefined && until <= now.toISOString()) deleteMeta(q, PAUSED_UNTIL)
}

/** The limits `workId` hit in a row before this one (0 when the streak is another work's, or none). */
function limitStreakOf(q: Queries, workId: string): number {
  try {
    const streak = JSON.parse(getMeta(q, LIMIT_STREAK) ?? 'null') as { workId?: unknown; count?: unknown } | null
    return streak?.workId === workId && typeof streak.count === 'number' ? streak.count : 0
  } catch {
    // A value that is not ours to read: the streak starts again.
    return 0
  }
}

/**
 * A limit adds no attempt (D10): back to the queue, and the queue pauses until the reset. The
 * `LIMIT_STREAK_MAX`-th in a row of the same work counts as a failed attempt, said in `warning`.
 */
function limited(q: Queries, work: Work, result: Extract<RunFailure, { kind: 'limit' }>, deps: ReturnDeps, now: Date): Result<Aftermath> {
  const until = result.resetsAt ?? new Date(now.getTime() + LIMIT_PAUSE_MS).toISOString()
  const already = getMeta(q, PAUSED_UNTIL)
  setMeta(q, PAUSED_UNTIL, already !== undefined && already > until ? already : until)
  const streak = limitStreakOf(q, work.id) + 1
  if (streak >= LIMIT_STREAK_MAX) {
    deleteMeta(q, LIMIT_STREAK)
    const counted = failedRun(q, work, `${result.reason}, ${streak} times in a row`, deps, now)
    if (!counted.ok) return counted
    return ok({ ...counted.value, warning: `${work.kind} ${work.id} hit the usage limit ${streak} times in a row: counted as a failed attempt` })
  }
  setMeta(q, LIMIT_STREAK, JSON.stringify({ workId: work.id, count: streak }))
  const saved = saveWork(q, { ...work, state: 'queued', notBefore: null, reason: result.reason, updatedAt: now.toISOString() })
  return saved.ok ? ok(NOTHING) : saved
}

/** The row of `work` after one more failed attempt: back to the queue at 2 or 10 min, or failed for good. Pure. */
function afterFailure(work: Work, reason: string, now: Date): Work {
  const attempts = work.attempts + 1
  const delay = RETRY_DELAYS_MS[attempts - 1]
  const updatedAt = now.toISOString()
  if (attempts < MAX_ATTEMPTS && delay !== undefined) {
    return { ...work, state: 'queued', attempts, notBefore: new Date(now.getTime() + delay).toISOString(), reason, updatedAt }
  }
  return { ...work, state: 'failed', attempts, notBefore: null, reason, updatedAt }
}

function failedRun(q: Queries, work: Work, reason: string, deps: ReturnDeps, now: Date): Result<Aftermath> {
  liftPause(q, work, now)
  const next = afterFailure(work, reason, now)
  const saved = saveWork(q, next)
  if (!saved.ok || next.state !== 'failed') return saved.ok ? ok(NOTHING) : saved
  return superseded(q, next) ? ok(NOTHING) : workFailed(q, next, deps, now)
}

/** The reason of a run whose return could not be written (D10: a failure, so it counts an attempt). */
export const NOT_WRITTEN = 'result-not-written'

/**
 * A return whose `tx` rolled back (a linter that threw, a transition refused): what came back is lost,
 * so the run IS a failed one — an attempt, the retries of D10, the third failure by class — with a
 * `prepared { notWritten }` event, in a `tx` of its own. Never a work left `running` that only a
 * restart would requeue.
 */
export function returnNotWritten(q: Queries, work: Work, deps: ReturnDeps, now: Date): Result<Aftermath> {
  const current = getWork(q, work.id) ?? work
  const app = applicationOfRef(q, work.ref)
  const followupId = app === undefined || app.id === work.ref ? {} : { followupId: work.ref }
  const data = { kind: work.kind, workId: work.id, notWritten: true, reason: NOT_WRITTEN, ...followupId }
  appendEvent(q, { kind: 'prepared', data, applicationId: app?.id ?? null, companyId: app?.companyId ?? null }, now)
  return failedRun(q, current, NOT_WRITTEN, deps, now)
}

/** The last resort when even `returnNotWritten` rolled back (its third failure lints too): the row alone. */
export function markNotWritten(q: Queries, work: Work, now: Date): Result<void> {
  return saveWork(q, afterFailure(getWork(q, work.id) ?? work, NOT_WRITTEN, now))
}

function succeeded(q: Queries, work: Work, output: JobOutput, deps: ReturnDeps, now: Date): Result<Aftermath> {
  liftPause(q, work, now)
  const saved = saveWork(q, { ...work, state: 'done', notBefore: null, reason: null, updatedAt: now.toISOString() })
  if (!saved.ok) return saved
  if (output.type !== 'apply' && superseded(q, work)) {
    const discarded = discard(q, work, now)
    return discarded.ok ? ok(NOTHING) : discarded
  }
  const written =
    output.type === 'application'
      ? applicationReturned(q, work, output.artifacts, deps, now)
      : output.type === 'followup'
        ? followupReturned(q, work, output.version, deps, now)
        : output.apply(q, now)
  return written.ok ? ok(NOTHING) : written
}

/** What came back from a run of `work`, written in the caller's `tx` (one per return). */
export function writeReturn(q: Queries, work: Work, result: JobResult, deps: ReturnDeps, now: Date): Result<Aftermath> {
  const current = getWork(q, work.id) ?? work
  if (result.ok) return succeeded(q, current, result.output, deps, now)
  if (result.kind === 'limit') return limited(q, current, result, deps, now)
  return failedRun(q, current, result.reason, deps, now)
}
