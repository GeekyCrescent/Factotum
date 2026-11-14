/**
 * The open batch over the store (tasks R1; design D15): `startBatch` and `batch`, the two reads the
 * review screen polls. What enters and in what order is `batch.ts`'s (pure); this file reads the pool,
 * keeps the batch in `batches`, and keeps it honest on every read:
 *
 * - an undecided item whose entity LEFT a batch state (sent by «Approve» elsewhere, closed, sent by
 *   the S6b reimport…) leaves the open batch — the read prunes it, whoever moved it;
 * - a rewrite that CAME BACK, failed or not (A4), is appended at its end.
 *
 * `startBatch` NEVER WAITS FOR THE NETWORK (crit. 46b): an item whose address is not checked enters
 * anyway, and its check is queued in front (N4) AFTER the `tx`, without awaiting it.
 */

import type { Logger } from '@factotum/core'
import { uuidv7 } from '@factotum/sessions'

import { todayIn } from '../seed/by-hand.ts'
import { isStaleCheck } from '../state.ts'
import type { Db, Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { fail, ok, type Result } from '../types.ts'
import {
  APP_IN_BATCH,
  appendReturned,
  buildBatch,
  FOLLOWUP_IN_BATCH,
  malformedMarks,
  pendingRewrites,
  pruneBatch,
  REVIEW_MARK_KINDS,
  type Batch,
  type Pool,
  type ReviewItemRef,
} from './batch.ts'
import { withSeen, type SeenBatch } from './seen.ts'

export interface OpenDeps {
  readonly db: Db
  readonly now: () => Date
  /** The module's zone: «today» of `holdUntil` and of a skip. */
  readonly timeZone: string
  /** N4's `enqueueContacts(ids, { front: true })`, injected (the check queue is built elsewhere): in front, in this order. */
  readonly enqueueChecks: (contactIds: readonly string[]) => unknown
  /** Where a check queue that fails after the batch was written goes. */
  readonly log: Logger
  /** UUIDv7 unless a test names the items. */
  readonly newId?: () => string
}

const asBatch = (stored: repo.StoredBatch): Batch => stored as unknown as Batch

function poolOf(q: Queries): Pool {
  return {
    applications: repo.reviewApplications(q, APP_IN_BATCH),
    followups: repo.reviewFollowups(q, FOLLOWUP_IN_BATCH),
    proposals: repo.pendingProposals(q),
    replies: repo.pendingAsks(q),
    marks: repo.reviewMarks(q, REVIEW_MARK_KINDS),
  }
}

/**
 * How many items «Start review» would put in a new batch, before `batchSize` (R8): `buildBatch` over the
 * pool as it is now — the `ready` AND the `in-review` (blocked) ones, minus what is skipped today or
 * held — so the tracker never offers «Start review (0)» while blocked items wait (crit. 28b, D15).
 */
export function newBatchCount(q: Queries, at: Date, timeZone: string): number {
  let n = 0
  const newId = (): string => `count-${(n += 1)}`
  return buildBatch(poolOf(q), { today: todayIn(at, timeZone), timeZone, batchSize: Number.POSITIVE_INFINITY, newId }).length
}

/**
 * Whether the entity of an item is still in a batch state. A reply stays until it is marked done
 * (`pendingAsks`: `asks` holds their event ids). The tracker counts the open batch with it (review 1a).
 */
export function isLive(q: Queries, item: ReviewItemRef, asks: ReadonlySet<string>): boolean {
  const appLive = (id: string): boolean => APP_IN_BATCH.includes(repo.getApplication(q, id)?.state ?? 'closed')
  const followupLive = (id: string): boolean => FOLLOWUP_IN_BATCH.includes(repo.getFollowup(q, id)?.state ?? 'cancelled')
  switch (item.kind) {
    case 'application':
      return appLive(item.applicationId)
    case 'followup':
      return followupLive(item.followupId)
    case 'rewritten':
      return item.target === 'application' ? appLive(item.id) : followupLive(item.id)
    case 'proposal':
      return repo.proposalState(q, item.proposalId) === 'pending'
    case 'reply':
      return asks.has(item.eventId)
  }
}

/** The current version of each entity a pending rewrite names, when it is in a batch state (and not the test one). */
function liveVersions(pool: Pool): Readonly<Record<string, number>> {
  const apps = pool.applications.filter((a) => !a.test).map((a) => [a.id, a.version] as const)
  const followups = pool.followups.map((f) => [f.id, f.version] as const)
  return Object.fromEntries([...apps, ...followups])
}

/** The open batch, pruned and with the returned rewrites appended; written back when that changed it. */
function synced(q: Queries, stored: repo.StoredBatch, newId: () => string): Batch {
  const batch = asBatch(stored)
  const pool = poolOf(q)
  const asks = new Set(pool.replies.map((reply) => reply.eventId))
  const next = appendReturned(
    pruneBatch(batch, (item) => isLive(q, item, asks)),
    pendingRewrites(pool.marks),
    liveVersions(pool),
    newId,
  )
  if (next !== batch) repo.saveBatch(q, next)
  return next
}

/** The contacts of the email items whose check is due (checking, never checked or stale), in the batch's order. */
function dueContacts(q: Queries, items: readonly ReviewItemRef[], now: Date): readonly string[] {
  const contactOf = (item: ReviewItemRef): string | null => {
    if (item.kind === 'application') {
      const app = repo.getApplication(q, item.applicationId)
      return app?.channel === 'email' ? app.target.contactId : null
    }
    if (item.kind === 'followup') {
      const row = repo.getFollowup(q, item.followupId)
      return row?.channel === 'email' ? row.contactId : null
    }
    return null
  }
  const due = items.map(contactOf).filter((id): id is string => {
    const address = id === null ? null : (repo.getContact(q, id)?.address ?? null)
    return address !== null && (address.status === 'checking' || isStaleCheck(address, now))
  })
  return [...new Set(due)]
}

/** Both answer each item with its `seen` (D15 «Lo que se vio es lo que se aprueba»), for `GET|POST /batch`. */
export interface Opened {
  readonly startBatch: () => Result<SeenBatch>
  /** The open batch, or null when none is open. */
  readonly batch: () => Result<SeenBatch | null>
}

export function openReview(deps: OpenDeps): Opened {
  const { db, now } = deps
  const newId = deps.newId ?? (() => uuidv7(now().getTime()))

  function startBatch(): Result<SeenBatch> {
    const at = now()
    const built = db.tx((q) => {
      const profile = repo.latestProfileVersion(q)?.profile
      if (profile === undefined) return fail<{ batch: SeenBatch; due: readonly string[]; malformed: readonly string[] }>('conflict', 'no-profile')
      repo.closeBatches(q, at)
      const pool = poolOf(q)
      const items = buildBatch(pool, { today: todayIn(at, deps.timeZone), timeZone: deps.timeZone, batchSize: profile.batchSize, newId })
      const batch: Batch = { id: newId(), items, cursor: 0, results: {} }
      repo.insertBatch(q, batch as unknown as repo.StoredBatch, at)
      return ok({ batch: withSeen(q, batch), due: dueContacts(q, items, at), malformed: malformedMarks(pool.marks) })
    })
    if (!built.ok) return built
    // Once per batch, not on every poll: what the batch read but could not use as written.
    for (const line of built.value.malformed) deps.log.warn(`jobs review: ${line}`)
    if (built.value.due.length > 0) queueChecks(built.value.due)
    return ok(built.value.batch)
  }

  /** After the `tx`: the batch is written, so a check queue that fails is logged, never the batch's failure. */
  function queueChecks(contactIds: readonly string[]): void {
    try {
      deps.enqueueChecks(contactIds)
    } catch (error) {
      deps.log.error(`jobs review: the address checks of the new batch were not queued: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function batch(): Result<SeenBatch | null> {
    return db.tx((q) => {
      const stored = repo.openBatch(q)
      return ok(stored === undefined ? null : withSeen(q, synced(q, stored, newId)))
    })
  }

  return { startBatch, batch }
}
