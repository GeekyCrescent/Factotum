/**
 * The event log (design D2, requirements crit. 6): every writer appends its event here, on the same
 * `q` and so in the same `tx`.
 */

import { uuidv7 } from '@factotum/sessions'
import type { EventKind, JobEvent } from '../../types.ts'
import type { Queries } from '../db.ts'
import { deepFreeze, json, text, textOrNull, type Row } from './rows.ts'

/** What a writer is told to log; it fills in the ids of the entity it wrote. */
export interface EventSpec {
  readonly kind: EventKind
  readonly data?: Readonly<Record<string, unknown>>
  /** When it happened; `now` by default. */
  readonly at?: string
}

export interface EventInput extends EventSpec {
  readonly applicationId: string | null
  readonly companyId: string | null
}

export function appendEvent(q: Queries, input: EventInput, now: Date): JobEvent {
  const event: JobEvent = {
    id: uuidv7(now.getTime()),
    at: input.at ?? now.toISOString(),
    recordedAt: now.toISOString(),
    applicationId: input.applicationId,
    companyId: input.companyId,
    kind: input.kind,
    data: input.data ?? {},
  }
  q.run(
    'INSERT INTO events (id, at, recorded_at, application_id, company_id, kind, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    event.id,
    event.at,
    event.recordedAt,
    event.applicationId,
    event.companyId,
    event.kind,
    JSON.stringify(event.data),
  )
  return deepFreeze(event)
}

const toEvent = (row: Row): JobEvent =>
  deepFreeze({
    id: text(row, 'id'),
    at: text(row, 'at'),
    recordedAt: text(row, 'recorded_at'),
    applicationId: textOrNull(row, 'application_id'),
    companyId: textOrNull(row, 'company_id'),
    kind: text(row, 'kind') as EventKind,
    data: json(row, 'data', {}),
  })

/** In the order they were written. */
export const eventsOf = (q: Queries, applicationId: string): readonly JobEvent[] =>
  q.all<Row>('SELECT * FROM events WHERE application_id = ? ORDER BY rowid', applicationId).map(toEvent)

export const withData = (spec: EventSpec, extra: Readonly<Record<string, unknown>>): EventSpec => ({ ...spec, data: { ...spec.data, ...extra } })

const PENDING_DEFERRED = `e.kind = 'reply' AND json_extract(e.data, '$.deferred') = 1
  AND NOT EXISTS (SELECT 1 FROM events a WHERE a.application_id = e.application_id AND a.kind = 'reply-applied'
                  AND json_extract(a.data, '$.replyEventId') = e.id)`

/**
 * The `reply { deferred: true }` events of an application that no `reply-applied { replyEventId }`
 * cites yet, in the order they were written (v6.1, design D3 «Respuesta mientras el `initial` está `sending`»).
 */
export const pendingDeferredReplies = (q: Queries, applicationId: string): readonly JobEvent[] =>
  q.all<Row>(`SELECT * FROM events e WHERE e.application_id = ? AND ${PENDING_DEFERRED} ORDER BY e.rowid`, applicationId).map(toEvent)

/** The applications with a deferred reply not applied yet (for the opening `tx`, after `recoverOnStart`). */
export const applicationsWithDeferredReplies = (q: Queries): readonly string[] =>
  q
    .all<Row>(`SELECT DISTINCT e.application_id AS id FROM events e WHERE e.application_id IS NOT NULL AND ${PENDING_DEFERRED} ORDER BY e.application_id`)
    .map((row) => text(row, 'id'))
