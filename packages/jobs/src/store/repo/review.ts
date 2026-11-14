/**
 * The review's queries (tasks R1, R2; design D15): what may enter a batch, and the batch itself.
 *
 * A BATCH IS NOT ENTITY STATE: writing it carries no event (like `meta`). What the owner decides in
 * it is written by the entity's own writer, with its event; the batch only keeps the order, the
 * cursor and the result of each item.
 */

import type { AppState, EventKind, FollowupState } from '../../types.ts'
import type { Queries } from '../db.ts'
import { deepFreeze, json, numberOrNull, text, textOrNull, type Row } from './rows.ts'

/** The shapes are `review/batch.ts`'s; declared here again, structurally, so the store does not import the review. */
export interface StoredBatch {
  readonly id: string
  readonly items: readonly Readonly<Record<string, unknown>>[]
  readonly cursor: number
  readonly results: Readonly<Record<string, string>>
}

export interface ApplicationCandidateRow {
  readonly id: string
  readonly state: AppState
  readonly score: number | null
  readonly holdUntil: string | null
  readonly test: boolean
  readonly version: number
}

export interface FollowupCandidateRow {
  readonly id: string
  readonly state: FollowupState
  readonly version: number
}

export interface ReviewMarkRow {
  readonly applicationId: string
  readonly followupId: string | null
  readonly kind: EventKind
  readonly at: string
  readonly data: Readonly<Record<string, unknown>>
}

/** Applications in a batch state, the test one included (the review decides), with their score, oldest first. */
export function reviewApplications(q: Queries, states: readonly AppState[]): readonly ApplicationCandidateRow[] {
  const marks = states.map(() => '?').join(', ')
  return q
    .all<Row>(
      `SELECT a.id, a.state, a.hold_until, a.test, a.version, o.score FROM applications a JOIN opportunities o ON o.id = a.opportunity_id
       WHERE a.state IN (${marks}) ORDER BY a.rowid`,
      ...states,
    )
    .map((row) =>
      deepFreeze({
        id: text(row, 'id'),
        state: text(row, 'state') as AppState,
        score: numberOrNull(row, 'score'),
        holdUntil: textOrNull(row, 'hold_until'),
        test: row.test === 1,
        version: Number(row.version),
      }),
    )
}

export function reviewFollowups(q: Queries, states: readonly FollowupState[]): readonly FollowupCandidateRow[] {
  const marks = states.map(() => '?').join(', ')
  return q
    .all<Row>(`SELECT id, state, version FROM followups WHERE state IN (${marks}) ORDER BY created_at, rowid`, ...states)
    .map((row) => deepFreeze({ id: text(row, 'id'), state: text(row, 'state') as FollowupState, version: Number(row.version) }))
}

export const pendingProposals = (q: Queries): readonly string[] =>
  q.all<Row>("SELECT id FROM proposals WHERE state = 'pending' ORDER BY created_at, rowid").map((row) => text(row, 'id'))

/** The `asks-something` replies (not deferred) that no `note { replyEventId }` marked done (D15 «Respuesta»). */
export const pendingAsks = (q: Queries): readonly { readonly applicationId: string; readonly eventId: string }[] =>
  q
    .all<Row>(
      `SELECT e.id, e.application_id FROM events e
       WHERE e.kind = 'reply' AND e.application_id IS NOT NULL AND json_extract(e.data, '$.class') = 'asks-something'
         AND coalesce(json_extract(e.data, '$.deferred'), 0) = 0
         AND NOT EXISTS (SELECT 1 FROM events d WHERE d.kind = 'note' AND json_extract(d.data, '$.replyEventId') = e.id)
       ORDER BY e.rowid`,
    )
    .map((row) => deepFreeze({ applicationId: text(row, 'application_id'), eventId: text(row, 'id') }))

/** The events of these kinds, of every application and follow-up, in the order they were written. */
export function reviewMarks(q: Queries, kinds: readonly EventKind[]): readonly ReviewMarkRow[] {
  const marks = kinds.map(() => '?').join(', ')
  return q
    .all<Row>(`SELECT application_id, kind, at, data FROM events WHERE application_id IS NOT NULL AND kind IN (${marks}) ORDER BY rowid`, ...kinds)
    .map((row) => {
      const data = json<Readonly<Record<string, unknown>>>(row, 'data', {})
      const followupId = typeof data.followupId === 'string' ? data.followupId : null
      return deepFreeze({ applicationId: text(row, 'application_id'), followupId, kind: text(row, 'kind') as EventKind, at: text(row, 'at'), data })
    })
}

export const proposalState = (q: Queries, id: string): string | null => textOrNull(q.get<Row>('SELECT state FROM proposals WHERE id = ?', id) ?? {}, 'state')

const toBatch = (row: Row): StoredBatch =>
  deepFreeze({ id: text(row, 'id'), items: json(row, 'items', []), cursor: Number(row.cursor), results: json(row, 'results', {}) })

/** The batch not closed yet (the newest, if ever more than one). */
export const openBatch = (q: Queries): StoredBatch | undefined => {
  const row = q.get<Row>('SELECT * FROM batches WHERE closed_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1')
  return row === undefined ? undefined : toBatch(row)
}

export function insertBatch(q: Queries, batch: StoredBatch, now: Date): void {
  q.run(
    'INSERT INTO batches (id, created_at, items, cursor, results) VALUES (?, ?, ?, ?, ?)',
    batch.id,
    now.toISOString(),
    JSON.stringify(batch.items),
    batch.cursor,
    JSON.stringify(batch.results),
  )
}

export function saveBatch(q: Queries, batch: StoredBatch): void {
  q.run('UPDATE batches SET items = ?, cursor = ?, results = ? WHERE id = ?', JSON.stringify(batch.items), batch.cursor, JSON.stringify(batch.results), batch.id)
}

/** Closes every open batch: a new one is starting. */
export function closeBatches(q: Queries, now: Date): void {
  q.run('UPDATE batches SET closed_at = ? WHERE closed_at IS NULL', now.toISOString())
}
