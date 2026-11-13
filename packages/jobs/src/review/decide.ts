/**
 * The owner's decision on one item of the open batch (tasks R2; design D15 «Decision», D3). C1's
 * facade only exposes it. APPLICATIONS ONLY (v5, X7): a follow-up's paths (T-F3…T-F7, T-F12, T-F15)
 * are R2b, and a follow-up item answers `conflict { reason: 'followups-not-ready' }`.
 *
 * - `approve` goes through the SENDER (E1/E1b): an email to `sending` (T-A11), a manual channel to
 *   `approved` (T-A12). Its refusals pass through untouched (`check-pending`, `address-unverified`…).
 * - `skip` needs a reason: «not a fit» closes it (T-A22); any other leaves the state and only writes
 *   `skipped { reason }`, which keeps it out of today's batches (S10).
 * - `instruct` with a letter: `rewriting` (T-A7), the `instruction` event (`instructionEvent`) and a
 *   `rewrite` queued `interactive`. Without one (v6, M9): no rewrite — `generating` (T-A4) with a NEW
 *   `letter` queued, which reads the instruction from the same event.
 * - `override` («I checked it», `checkIt`): `unsupported-claim`, `external-link`, `ad-closed`, and only
 *   when one of them is open (`conflict nothing-to-check` otherwise); the warning keeps its
 *   code and gets `overridden`, the event carries the codes (never the text), and T-A5/T-A6 re-decide.
 * - `switch-to-form` (T-A10): to the ad's URL or the careers page, `channel-changed`, and a re-lint of
 *   that application (L4's `relintOne`, injected).
 *
 * AN ITEM IS ITS `itemId`. One not in the open batch is `not-found`; one already decided is
 * `conflict already-decided`. A decision with a result moves the cursor past its item.
 */

import { instructionEvent } from '../ai/returns.ts'
import type { Queue, RelintFn } from '../ai/queue.ts'
import type { Approved, Sender } from '../send/send.ts'
import { checkIt } from '../build/verify.ts'
import { appTransition } from '../state.ts'
import type { Db, Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { fail, ok, type Application, type Result, type WarningCode } from '../types.ts'
import type { Batch, ItemResult, ReviewItemRef } from './batch.ts'

export const DECISION_KINDS = ['approve', 'skip', 'instruct', 'override', 'switch-to-form', 'switch-channel'] as const
export type DecisionKind = (typeof DECISION_KINDS)[number]

export interface Decision {
  readonly itemId: string
  readonly kind: DecisionKind
  /** `skip`: why. */
  readonly reason?: string
  /** `instruct`: the owner's words. */
  readonly text?: string
  /** `approve`: «Send anyway» (T-D5). */
  readonly addressOverride?: boolean
  /** `override`: the codes «I checked it» is given for. */
  readonly warningCodes?: readonly WarningCode[]
}

/** The skip reason that closes the application (requirements crit. 30). */
export const NOT_A_FIT = 'not a fit'
export const MAX_INSTRUCTION_CHARS = 2_000
export const MAX_REASON_CHARS = 200

export interface DecideDeps {
  readonly db: Db
  readonly now: () => Date
  /** The sender's `approve` (E1). */
  readonly approve: Sender['approve']
  /** The generation queue: `enqueue` inside the decision's `tx`, `pump` after it. */
  readonly queue: Pick<Queue, 'enqueue' | 'pump'>
  /** Whether the printed CV is on disk (T-A5); `existsSync` under the state dir in production. */
  readonly pdfExists: (path: string) => boolean
  /** L4's re-lint of one entity, for T-A10 (injected, as the queue's). */
  readonly relintOne: RelintFn
}

export interface Decided {
  readonly itemId: string
  /** What the batch records for the item; null when it stays on screen (`override`, `switch-to-form`). */
  readonly result: ItemResult | null
  /** The sender's answer to an `approve`. */
  readonly send?: Approved
}

interface Target {
  readonly batch: Batch
  readonly item: ReviewItemRef
  readonly applicationId: string
}

const text = (value: string | undefined): string => (value ?? '').trim()

/** The open batch's item, and the application it is about. */
function targetOf(q: Queries, itemId: string): Result<Target> {
  const stored = repo.openBatch(q)
  const batch = stored as unknown as Batch | undefined
  const item = batch?.items.find((i) => i.itemId === itemId)
  if (batch === undefined || item === undefined) return fail('not-found', 'no such item in the open batch')
  if (batch.results[itemId] !== undefined) return fail('conflict', 'already-decided')
  if (item.kind === 'followup' || (item.kind === 'rewritten' && item.target === 'followup')) return fail('conflict', 'followups-not-ready')
  if (item.kind === 'application') return ok({ batch, item, applicationId: item.applicationId })
  if (item.kind === 'rewritten') return ok({ batch, item, applicationId: item.id })
  return fail('conflict', `a ${item.kind} is not decided here`)
}

/** The batch with the item's result, the cursor past it. */
function record(q: Queries, target: Target, result: ItemResult): void {
  const index = target.batch.items.findIndex((i) => i.itemId === target.item.itemId)
  const batch: Batch = { ...target.batch, results: { ...target.batch.results, [target.item.itemId]: result }, cursor: Math.max(target.batch.cursor, index + 1) }
  repo.saveBatch(q, batch as unknown as repo.StoredBatch)
}

function application(q: Queries, id: string): Result<Application> {
  const app = repo.getApplication(q, id)
  return app === undefined ? fail('not-found', 'no such application') : ok(app)
}

/** Moves the application with `event` and saves it with `spec`. */
function move(q: Queries, app: Application, event: Parameters<typeof appTransition>[1], spec: repo.EventSpec, now: Date): Result<Application> {
  const moved = appTransition(app, event, now)
  if (!moved.ok) return moved
  const saved = repo.saveApplication(q, moved.value, spec, now)
  return saved.ok ? moved : saved
}

function skip(q: Queries, app: Application, reason: string, now: Date): Result<void> {
  if (app.state !== 'in-review' && app.state !== 'ready') return fail('conflict', `skip is not a transition from ${app.state}`)
  const spec = { kind: 'skipped', data: { reason } } as const
  if (reason === NOT_A_FIT) {
    const closed = move(q, app, { type: 'skip-not-a-fit', reason }, spec, now) // T-A22
    return closed.ok ? ok(undefined) : closed
  }
  repo.appendEvent(q, { ...spec, applicationId: app.id, companyId: app.companyId }, now)
  return ok(undefined)
}

function instruct(q: Queries, deps: DecideDeps, app: Application, words: string, now: Date): Result<void> {
  const hasLetter = repo.getArtifacts(q, app.id, app.version)?.letter != null
  const moved = move(q, app, { type: 'instruction', hasLetter }, instructionEvent(words), now) // T-A7, or T-A4 without a letter
  if (!moved.ok) return moved
  if (hasLetter) {
    const work = deps.queue.enqueue(q, { kind: 'rewrite', ref: app.id })
    return work.ok ? ok(undefined) : work
  }
  const work = deps.queue.enqueue(q, { kind: 'letter', ref: app.id, lane: 'interactive' })
  if (!work.ok) return work
  repo.appendEvent(q, { kind: 'retried', data: { kinds: ['letter'] }, applicationId: app.id, companyId: app.companyId }, now)
  return ok(undefined)
}

/** «I checked it»: `checkIt` of `verify.ts`, the one implementation (T-A5 / T-A6). */
function override(q: Queries, deps: DecideDeps, app: Application, codes: readonly WarningCode[], now: Date): Result<void> {
  return checkIt(q, { applicationId: app.id, codes, pdfExists: deps.pdfExists }, now)
}

function switchToForm(q: Queries, deps: DecideDeps, app: Application, now: Date): Result<void> {
  const url = repo.getOpportunity(q, app.opportunityId)?.url ?? repo.getCompany(q, app.companyId)?.careersUrl ?? null
  const moved = move(q, app, { type: 'switch-to-form', url }, { kind: 'channel-changed', data: { from: 'email', to: 'form' } }, now) // T-A10
  if (!moved.ok) return moved
  return deps.relintOne(q, { kind: 'application', id: app.id }, now)
}

/** The decisions written in the batch's own `tx`: everything but `approve`. */
function writeDecision(q: Queries, deps: DecideDeps, target: Target, decision: Decision, now: Date): Result<ItemResult | null> {
  const app = application(q, target.applicationId)
  if (!app.ok) return app
  const then = (written: Result<void>, result: ItemResult | null): Result<ItemResult | null> => {
    if (!written.ok) return written
    if (result !== null) record(q, target, result)
    return ok(result)
  }
  switch (decision.kind) {
    case 'skip':
      return then(skip(q, app.value, text(decision.reason), now), 'skipped')
    case 'instruct':
      return then(instruct(q, deps, app.value, text(decision.text), now), 'instructed')
    case 'override':
      return then(override(q, deps, app.value, decision.warningCodes ?? [], now), null)
    case 'switch-to-form':
      return then(switchToForm(q, deps, app.value, now), null)
    default:
      return fail('conflict', `${decision.kind} is a follow-up decision`)
  }
}

/** Checks what the owner typed before anything is read (a system boundary). */
function invalid(decision: Decision): Result<never> | null {
  if (!DECISION_KINDS.includes(decision.kind)) return fail('invalid', 'unknown decision', 'kind')
  if (decision.kind === 'skip' && (text(decision.reason) === '' || text(decision.reason).length > MAX_REASON_CHARS)) return fail('invalid', 'a skip needs a reason', 'reason')
  if (decision.kind === 'instruct' && (text(decision.text) === '' || text(decision.text).length > MAX_INSTRUCTION_CHARS)) {
    return fail('invalid', `an instruction is 1 to ${MAX_INSTRUCTION_CHARS} characters`, 'text')
  }
  return null
}

function approve(deps: DecideDeps, decision: Decision): Result<Decided> {
  const target = deps.db.read((q) => targetOf(q, decision.itemId))
  if (!target.ok) return target
  const sent = deps.approve(target.value.applicationId, 'initial', { addressOverride: decision.addressOverride === true })
  if (!sent.ok) return sent
  // The send is written; the batch's note of it is its own `tx`, re-read so a decision meanwhile is kept.
  deps.db.tx((q) => {
    const fresh = targetOf(q, decision.itemId)
    if (fresh.ok) record(q, fresh.value, 'approved')
    return ok(undefined)
  })
  return ok({ itemId: decision.itemId, result: 'approved', send: sent.value })
}

export function decide(deps: DecideDeps, decision: Decision): Result<Decided> {
  const refused = invalid(decision)
  if (refused !== null) return refused
  if (decision.kind === 'approve') return approve(deps, decision)
  const now = deps.now()
  const written = deps.db.tx((q) => {
    const target = targetOf(q, decision.itemId)
    return target.ok ? writeDecision(q, deps, target.value, decision, now) : target
  })
  if (!written.ok) return written
  if (decision.kind === 'instruct') deps.queue.pump()
  return ok({ itemId: decision.itemId, result: written.value })
}
