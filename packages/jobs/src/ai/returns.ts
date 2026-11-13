/**
 * What happens when a work comes back (tasks G2b, G4; design D10, D3 «La guarda»): written by the
 * queue in ONE `tx` with the work row, so the entity and its work never disagree.
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
 * with `data.followupId` for a follow-up): the review writes it with T-A7/T-F3, and `work` has no
 * column for it.
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
}

const NOTHING: Aftermath = { rewriteFailed: null }

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

/** The text of the last instruction given to this entity (T-A7, T-F3); '' when none was written. */
function instructionOf(q: Queries, applicationId: string, followupId: string | null): string {
  const given = eventsOf(q, applicationId).filter((e) => e.kind === 'instruction' && (e.data.followupId ?? null) === followupId)
  const text = given.at(-1)?.data.instruction
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
  return saved.ok ? ok({ rewriteFailed: { kind: 'application', id: app.id } }) : saved
}

function followupRewriteFailed(q: Queries, row: Followup, work: Work, now: Date): Result<Aftermath> {
  if (row.state !== 'rewriting') return ok(NOTHING)
  const moved = followupTransition(row, { type: 'rewrite-failed' }, now) // T-F5
  if (!moved.ok) return moved
  const data = { instruction: instructionOf(q, row.applicationId, row.id), reason: work.reason }
  const saved = saveFollowup(q, moved.value, { kind: 'rewrite-failed', data }, now)
  return saved.ok ? ok({ rewriteFailed: { kind: 'followup', id: row.id } }) : saved
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
/** `meta` key: while it is in the future, no Claude work leaves the queue. */
export const PAUSED_UNTIL = 'pausedUntil'

/** An answer that is not a limit, after the pause ran out: the limit is gone, the concurrency opens. */
function liftPause(q: Queries, work: Work, now: Date): void {
  if (work.kind === 'reprint') return
  const until = getMeta(q, PAUSED_UNTIL)
  if (until !== undefined && until <= now.toISOString()) deleteMeta(q, PAUSED_UNTIL)
}

/** A limit adds no attempt (D10): back to the queue, and the queue pauses until the reset. */
function limited(q: Queries, work: Work, result: Extract<RunFailure, { kind: 'limit' }>, now: Date): Result<Aftermath> {
  const until = result.resetsAt ?? new Date(now.getTime() + LIMIT_PAUSE_MS).toISOString()
  const already = getMeta(q, PAUSED_UNTIL)
  setMeta(q, PAUSED_UNTIL, already !== undefined && already > until ? already : until)
  const saved = saveWork(q, { ...work, state: 'queued', notBefore: null, reason: result.reason, updatedAt: now.toISOString() })
  return saved.ok ? ok(NOTHING) : saved
}

function failedRun(q: Queries, work: Work, reason: string, deps: ReturnDeps, now: Date): Result<Aftermath> {
  liftPause(q, work, now)
  const attempts = work.attempts + 1
  const delay = RETRY_DELAYS_MS[attempts - 1]
  if (attempts < MAX_ATTEMPTS && delay !== undefined) {
    const notBefore = new Date(now.getTime() + delay).toISOString()
    const saved = saveWork(q, { ...work, state: 'queued', attempts, notBefore, reason, updatedAt: now.toISOString() })
    return saved.ok ? ok(NOTHING) : saved
  }
  const failed: Work = { ...work, state: 'failed', attempts, notBefore: null, reason, updatedAt: now.toISOString() }
  const saved = saveWork(q, failed)
  if (!saved.ok) return saved
  return superseded(q, failed) ? ok(NOTHING) : workFailed(q, failed, deps, now)
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
  if (result.kind === 'limit') return limited(q, current, result, now)
  return failedRun(q, current, result.reason, deps, now)
}
