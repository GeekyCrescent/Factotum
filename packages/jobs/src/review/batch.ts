/**
 * The review batch (tasks R1; design D15 «Lotes», «Qué entra al lote»; requirements crit. 28, 28b,
 * 35). PURE: what the store holds comes in as a `Pool`, and a batch comes out.
 *
 * WHAT ENTERS is design D15's list, and only it: applications `in-review`/`ready` (never `draft`,
 * `generating`, `rewriting`, `approved` nor anything sent), not held past today nor skipped today;
 * follow-ups `draft`/`ready` (a `draft` one enters with «Approve» off), not skipped today; proposals
 * `pending`; the rewrites that came back (failed ones too, A4); and the `asks-something` replies.
 * THE TEST APPLICATION never enters that list: while one is `in-review`/`ready`, the batch is it alone.
 *
 * THE ORDER is R28: replies, rewrites, follow-ups, proposals, `ready` by score, then the `in-review`
 * by score until `batchSize` — so a batch is never empty because everything is blocked (28b).
 *
 * AN ITEM IS NAMED BY ITS `itemId`, never by its position: a rewrite appended at the end or a decision
 * sent twice must never land on another item. `cursor` is the position of the item on screen, and
 * moves with it when the items before it leave.
 */

import type { AppState, EventKind, FollowupState } from '../types.ts'

export type ReviewItemRef = { readonly itemId: string } & (
  | { readonly kind: 'reply'; readonly applicationId: string; readonly eventId: string }
  | {
      readonly kind: 'rewritten'
      readonly target: 'application' | 'followup'
      readonly id: string
      readonly fromVersion: number
      /** The rewrite failed three times (A4): the version before, with «Try again». */
      readonly failed: boolean
    }
  | { readonly kind: 'followup'; readonly followupId: string }
  | { readonly kind: 'proposal'; readonly proposalId: string }
  | { readonly kind: 'application'; readonly applicationId: string }
)

export type ItemResult = 'approved' | 'skipped' | 'instructed' | 'sent'

export interface Batch {
  readonly id: string
  readonly items: readonly ReviewItemRef[]
  readonly cursor: number
  /** By itemId. */
  readonly results: Readonly<Record<string, ItemResult>>
}

export interface AppCandidate {
  readonly id: string
  readonly state: AppState
  /** The opportunity's score; null sorts last. */
  readonly score: number | null
  /** `YYYY-MM-DD`. */
  readonly holdUntil: string | null
  readonly test: boolean
  readonly version: number
}

export interface FollowupCandidate {
  readonly id: string
  readonly state: FollowupState
  readonly version: number
}

/** An event that says something about review: a decision, an instruction, a rewrite's return. */
export interface ReviewMark {
  readonly applicationId: string
  /** A follow-up's event carries it; null for the application's own. */
  readonly followupId: string | null
  readonly kind: EventKind
  readonly at: string
  readonly data: Readonly<Record<string, unknown>>
}

export interface Pool {
  readonly applications: readonly AppCandidate[]
  readonly followups: readonly FollowupCandidate[]
  /** `pending` proposals of the keeper (phase 3), oldest first. */
  readonly proposals: readonly string[]
  /** `asks-something` replies nobody marked done yet. */
  readonly replies: readonly { readonly applicationId: string; readonly eventId: string }[]
  /** In the order they were written. */
  readonly marks: readonly ReviewMark[]
}

export interface BuildOptions {
  /** `YYYY-MM-DD` in `timeZone`. */
  readonly today: string
  readonly timeZone: string
  readonly batchSize: number
  /** UUIDv7 in production. */
  readonly newId: () => string
}

export const APP_IN_BATCH: readonly AppState[] = ['in-review', 'ready']
export const FOLLOWUP_IN_BATCH: readonly FollowupState[] = ['draft', 'ready']

/** A rewrite that came back and nobody decided on since (A4: failed ones too). */
export interface PendingRewrite {
  readonly target: 'application' | 'followup'
  readonly id: string
  /** The version the return wrote (`rewritten { version }`); null when it failed or the event lacks it. */
  readonly version: number | null
  readonly failed: boolean
}

/** What ends a returned rewrite's wait: a decision, or another instruction. `override` does not. */
const SETTLING: ReadonlySet<EventKind> = new Set<EventKind>(['instruction', 'rewritten', 'rewrite-failed', 'approved', 'skipped'])
/** The events a batch reads (`Pool.marks`). */
export const REVIEW_MARK_KINDS: readonly EventKind[] = [...SETTLING]

const keyOf = (m: ReviewMark): string => m.followupId ?? m.applicationId

/** The entities whose last settling mark is a rewrite's return, in the order those returns were written. */
export function pendingRewrites(marks: readonly ReviewMark[]): readonly PendingRewrite[] {
  const last = new Map<string, ReviewMark>()
  for (const m of marks) {
    if (!SETTLING.has(m.kind)) continue
    last.delete(keyOf(m))
    last.set(keyOf(m), m)
  }
  return [...last.values()]
    .filter((m) => m.kind === 'rewritten' || m.kind === 'rewrite-failed')
    .map((m) => ({
      target: m.followupId === null ? 'application' : 'followup',
      id: keyOf(m),
      version: m.kind === 'rewritten' && typeof m.data.version === 'number' ? m.data.version : null,
      failed: m.kind === 'rewrite-failed',
    }))
}

/** `YYYY-MM-DD` of an instant in a zone. */
const dayOf = (at: string, timeZone: string): string => new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(at))

/** The entities (application or follow-up ids) skipped on `day` in `timeZone` (S10: back the next day). */
export function skippedOn(marks: readonly ReviewMark[], day: string, timeZone: string): ReadonlySet<string> {
  return new Set(marks.filter((m) => m.kind === 'skipped' && dayOf(m.at, timeZone) === day).map(keyOf))
}

/** The version a rewritten item diffs from: the one before the return, or the current one when it failed. */
const fromVersionOf = (r: PendingRewrite, current: number): number => (r.failed ? current : (r.version ?? current) - 1)

const byScore = (a: AppCandidate, b: AppCandidate): number => {
  if (a.score === b.score) return 0
  if (a.score === null) return 1
  if (b.score === null) return -1
  return b.score - a.score
}

type Draft = ReviewItemRef extends infer R ? (R extends unknown ? Omit<R, 'itemId'> : never) : never

function testBatch(applications: readonly AppCandidate[]): readonly Draft[] {
  return applications.filter((a) => a.test && APP_IN_BATCH.includes(a.state)).map((a) => ({ kind: 'application', applicationId: a.id }))
}

function rewrittenDrafts(pool: Pool, skipped: ReadonlySet<string>): readonly Draft[] {
  const apps = new Map(pool.applications.filter((a) => !a.test && APP_IN_BATCH.includes(a.state)).map((a) => [a.id, a.version]))
  const followups = new Map(pool.followups.filter((f) => FOLLOWUP_IN_BATCH.includes(f.state)).map((f) => [f.id, f.version]))
  return pendingRewrites(pool.marks).flatMap((r): Draft[] => {
    const current = (r.target === 'application' ? apps : followups).get(r.id)
    if (current === undefined || skipped.has(r.id)) return []
    return [{ kind: 'rewritten', target: r.target, id: r.id, fromVersion: fromVersionOf(r, current), failed: r.failed }]
  })
}

function applicationDrafts(pool: Pool, out: ReadonlySet<string>, today: string): readonly Draft[] {
  const eligible = pool.applications.filter((a) => !a.test && !out.has(a.id) && (a.holdUntil === null || a.holdUntil <= today))
  const inState = (state: AppState): readonly Draft[] =>
    eligible
      .filter((a) => a.state === state)
      .sort(byScore)
      .map((a) => ({ kind: 'application', applicationId: a.id }))
  return [...inState('ready'), ...inState('in-review')]
}

/** The items of a new batch, in R28's order, at most `batchSize`. */
export function buildBatch(pool: Pool, options: BuildOptions): readonly ReviewItemRef[] {
  const named = (drafts: readonly Draft[]): readonly ReviewItemRef[] => drafts.map((d) => ({ ...d, itemId: options.newId() }) as ReviewItemRef)
  const test = testBatch(pool.applications)
  if (test.length > 0) return named(test)
  const skipped = skippedOn(pool.marks, options.today, options.timeZone)
  const rewritten = rewrittenDrafts(pool, skipped)
  const out = new Set([...skipped, ...rewritten.map((d) => (d.kind === 'rewritten' ? d.id : ''))])
  const drafts: readonly Draft[] = [
    ...pool.replies.map((r) => ({ kind: 'reply', applicationId: r.applicationId, eventId: r.eventId }) as const),
    ...rewritten,
    ...pool.followups.filter((f) => FOLLOWUP_IN_BATCH.includes(f.state) && !out.has(f.id)).map((f) => ({ kind: 'followup', followupId: f.id }) as const),
    ...pool.proposals.map((id) => ({ kind: 'proposal', proposalId: id }) as const),
    ...applicationDrafts(pool, out, options.today),
  ]
  return named(drafts.slice(0, options.batchSize))
}

/** Without the items `drop` names; the cursor stays on its item (or the next one, if its own left). */
function without(batch: Batch, drop: (item: ReviewItemRef) => boolean): Batch {
  const before = batch.items.slice(0, batch.cursor).filter(drop).length
  if (!batch.items.some(drop)) return batch
  return { ...batch, items: batch.items.filter((item) => !drop(item)), cursor: batch.cursor - before }
}

/**
 * The open batch without the undecided items whose entity left a batch state (sent, closed,
 * reimported as sent…). A decided item stays: «← Back» shows it with its result (crit. 35).
 */
export function pruneBatch(batch: Batch, isLive: (item: ReviewItemRef) => boolean): Batch {
  return without(batch, (item) => batch.results[item.itemId] === undefined && !isLive(item))
}

/** The entity an item is about, for the items that have one to rewrite. */
function entityOf(item: ReviewItemRef): string | null {
  if (item.kind === 'application') return item.applicationId
  if (item.kind === 'followup') return item.followupId
  if (item.kind === 'rewritten') return item.id
  return null
}

/**
 * The rewrites that came back, appended at the end of the open batch (D15; A4: failed ones too) —
 * once: an undecided rewritten item of the same entity already there keeps its place. An undecided
 * plain item of that entity gives way to it.
 */
export function appendReturned(batch: Batch, returned: readonly PendingRewrite[], versions: Readonly<Record<string, number>>, newId: () => string): Batch {
  const undecided = (item: ReviewItemRef): boolean => batch.results[item.itemId] === undefined
  const waiting = new Set(batch.items.filter((i) => i.kind === 'rewritten' && undecided(i)).map(entityOf))
  const fresh = returned.filter((r) => !waiting.has(r.id) && versions[r.id] !== undefined)
  if (fresh.length === 0) return batch
  const entities = new Set(fresh.map((r) => r.id))
  const kept = without(batch, (item) => undecided(item) && item.kind !== 'rewritten' && entities.has(entityOf(item) ?? ''))
  const added: readonly ReviewItemRef[] = fresh.map((r) => ({
    itemId: newId(),
    kind: 'rewritten',
    target: r.target,
    id: r.id,
    fromVersion: fromVersionOf(r, versions[r.id] ?? 0),
    failed: r.failed,
  }))
  return { ...kept, items: [...kept.items, ...added] }
}
