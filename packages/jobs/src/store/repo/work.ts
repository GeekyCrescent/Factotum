/**
 * The generation queue (tasks G2a–G5, design D10; lane 1): the `work` table and `gen_requests`
 * (D3 «La guarda»). Writing a `work` row is not entity state and carries no event (like the startup
 * requeue); the queue writes the events of the entities it moves.
 */

import { ok, type Result } from '../../types.ts'
import type { Queries } from '../db.ts'
import { deepFreeze, notFound, text, textOrNull, type Row } from './rows.ts'

/** design D10. `reprint` runs no Claude: it does not count for `concurrency`, one at a time. */
export const WORK_KINDS = ['cv', 'letter', 'rewrite', 'verify', 'classify', 'extract', 'score', 'keeper', 'reprint'] as const
export type WorkKind = (typeof WORK_KINDS)[number]
export type Lane = 'interactive' | 'bulk'
export type WorkState = 'queued' | 'running' | 'done' | 'failed'

export interface Work {
  readonly id: string
  readonly kind: WorkKind
  /** The entity it works on: an application, or a follow-up for a follow-up's `rewrite`. */
  readonly ref: string
  readonly lane: Lane
  readonly state: WorkState
  readonly attempts: number
  /** ISO; null = now. */
  readonly notBefore: string | null
  /** The last failure, ours (never CLI text). */
  readonly reason: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

const toWork = (row: Row): Work =>
  deepFreeze({
    id: text(row, 'id'),
    kind: text(row, 'kind') as WorkKind,
    ref: text(row, 'ref'),
    lane: text(row, 'lane') as Lane,
    state: text(row, 'state') as WorkState,
    attempts: Number(row.attempts),
    notBefore: textOrNull(row, 'not_before'),
    reason: textOrNull(row, 'reason'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  })

export function insertWork(q: Queries, work: Work): void {
  q.run(
    'INSERT INTO work (id, kind, ref, lane, state, attempts, not_before, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    work.id,
    work.kind,
    work.ref,
    work.lane,
    work.state,
    work.attempts,
    work.notBefore,
    work.reason,
    work.createdAt,
    work.updatedAt,
  )
}

export const getWork = (q: Queries, id: string): Work | undefined => {
  const row = q.get<Row>('SELECT * FROM work WHERE id = ?', id)
  return row === undefined ? undefined : toWork(row)
}

/** Writes the state, attempts, `not_before` and reason a run moved. */
export function saveWork(q: Queries, work: Work): Result<void> {
  const updated = q.run(
    'UPDATE work SET state = ?, attempts = ?, not_before = ?, reason = ?, updated_at = ? WHERE id = ?',
    work.state,
    work.attempts,
    work.notBefore,
    work.reason,
    work.updatedAt,
    work.id,
  )
  return updated.changes === 0 ? notFound('work') : ok(undefined)
}

/** `queued` and due at `at` (no `not_before`, or reached), oldest first. */
export const dueWork = (q: Queries, at: string): readonly Work[] =>
  q.all<Row>("SELECT * FROM work WHERE state = 'queued' AND (not_before IS NULL OR not_before <= ?) ORDER BY created_at, rowid", at).map(toWork)

export const workByState = (q: Queries, state: WorkState): readonly Work[] =>
  q.all<Row>('SELECT * FROM work WHERE state = ? ORDER BY created_at, rowid', state).map(toWork)

/** The class of a generation request (D3 «La guarda»): `GenKind` of `types.ts`. */
export type GenRequestKind = 'letter' | 'cv' | 'followup'

/** The latest request per (entity, class): enqueueing overwrites it. */
export function setGenRequest(q: Queries, entityId: string, kind: GenRequestKind, workId: string): void {
  q.run(
    'INSERT INTO gen_requests (entity_id, kind, work_id) VALUES (?, ?, ?) ON CONFLICT (entity_id, kind) DO UPDATE SET work_id = excluded.work_id',
    entityId,
    kind,
    workId,
  )
}

export interface GenRequest {
  readonly kind: GenRequestKind
  readonly workId: string
  /** The state of its `work` row; null when the row is gone. */
  readonly state: WorkState | null
}

/** Every class requested of an entity, with the state of the work that holds it. */
export const genRequestsOf = (q: Queries, entityId: string): readonly GenRequest[] =>
  q
    .all<Row>('SELECT g.kind, g.work_id, w.state FROM gen_requests g LEFT JOIN work w ON w.id = g.work_id WHERE g.entity_id = ? ORDER BY g.kind', entityId)
    .map((row) => deepFreeze({ kind: text(row, 'kind') as GenRequestKind, workId: text(row, 'work_id'), state: textOrNull(row, 'state') as WorkState | null }))
