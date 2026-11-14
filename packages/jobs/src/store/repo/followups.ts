/** Follow-ups (design D12), and the send row each one in a send state needs. */

import type { Followup, Send } from '../../types.ts'
import { fail, ok, type Result } from '../../types.ts'
import type { Queries } from '../db.ts'
import { companyOf } from './applications.ts'
import { appendEvent, withData, type EventSpec } from './events.ts'
import { deepFreeze, json, notFound, text, textOrNull, type Row } from './rows.ts'
import { upsertSend } from './sends.ts'

const toFollowup = (row: Row): Followup => {
  const data = json<{ to: string | null; versions: Followup['versions'] }>(row, 'data', { to: null, versions: [] })
  return deepFreeze({
    id: text(row, 'id'),
    applicationId: text(row, 'application_id'),
    n: Number(row.n) as Followup['n'],
    channel: text(row, 'channel') as Followup['channel'],
    contactId: textOrNull(row, 'contact_id'),
    to: data.to,
    state: text(row, 'state') as Followup['state'],
    rewriteFrom: textOrNull(row, 'rewrite_from') as Followup['rewriteFrom'],
    version: Number(row.version),
    versions: data.versions,
    warnings: json(row, 'warnings', []),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  })
}

export const getFollowup = (q: Queries, id: string): Followup | undefined => {
  const row = q.get<Row>('SELECT * FROM followups WHERE id = ?', id)
  return row === undefined ? undefined : toFollowup(row)
}

export const followupsOf = (q: Queries, applicationId: string): readonly Followup[] =>
  q.all<Row>('SELECT * FROM followups WHERE application_id = ? ORDER BY n', applicationId).map(toFollowup)

export const followupsOfContact = (q: Queries, contactId: string): readonly Followup[] =>
  q.all<Row>('SELECT * FROM followups WHERE contact_id = ? ORDER BY rowid', contactId).map(toFollowup)

const followupData = (f: Followup): string => JSON.stringify({ to: f.to, versions: f.versions })

export function insertFollowup(q: Queries, f: Followup, event: EventSpec, now: Date): void {
  q.run(
    `INSERT INTO followups (id, application_id, n, channel, contact_id, state, rewrite_from, version, warnings, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.id,
    f.applicationId,
    f.n,
    f.channel,
    f.contactId,
    f.state,
    f.rewriteFrom,
    f.version,
    JSON.stringify(f.warnings),
    followupData(f),
    f.createdAt,
    f.updatedAt,
  )
  appendEvent(q, { ...withData(event, { followupId: f.id }), applicationId: f.applicationId, companyId: companyOf(q, f.applicationId) }, now)
}

/** The follow-up states that only exist beside a send row of their own (T-F6…T-F10, T-F14). */
const SEND_BACKED: ReadonlySet<Followup['state']> = new Set<Followup['state']>(['sending', 'sent', 'failed', 'send-unknown'])

/**
 * Why a follow-up and the send given with it cannot be written together, or null. A follow-up in a
 * send state without ITS row (same follow-up, same state) would be stuck after a restart: the startup
 * write only scans `sends`.
 */
function sendMismatch(f: Followup, send: Send | undefined): string | null {
  if (!SEND_BACKED.has(f.state)) return null
  if (send === undefined) return `a follow-up in ${f.state} needs its send row`
  if (send.followupId !== f.id) return `the send row given is not this follow-up's (${String(send.followupId)})`
  if (send.state !== f.state) return `the send row is ${send.state}, the follow-up ${f.state}`
  return null
}

/**
 * Writes a follow-up moved by `followupTransition` and, when given, its own send row (T-F6…T-F14).
 * In `sending`/`sent`/`failed`/`send-unknown` the send is REQUIRED: a `conflict` otherwise, before
 * anything is written.
 */
export function saveFollowup(q: Queries, f: Followup, event: EventSpec, now: Date, send?: Send): Result<void> {
  const mismatch = sendMismatch(f, send)
  if (mismatch !== null) return fail('conflict', mismatch)
  const updated = q.run(
    'UPDATE followups SET channel = ?, contact_id = ?, state = ?, rewrite_from = ?, version = ?, warnings = ?, data = ?, updated_at = ? WHERE id = ?',
    f.channel,
    f.contactId,
    f.state,
    f.rewriteFrom,
    f.version,
    JSON.stringify(f.warnings),
    followupData(f),
    f.updatedAt,
    f.id,
  )
  if (updated.changes === 0) return notFound('follow-up')
  if (send !== undefined) upsertSend(q, f.applicationId, send)
  appendEvent(q, { ...withData(event, { followupId: f.id }), applicationId: f.applicationId, companyId: companyOf(q, f.applicationId) }, now)
  return ok(undefined)
}
