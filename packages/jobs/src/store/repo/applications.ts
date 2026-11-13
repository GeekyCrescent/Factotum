/** Applications, with their sends (design D3). */

import type { Application } from '../../types.ts'
import { ok, type Result } from '../../types.ts'
import type { Queries } from '../db.ts'
import { appendEvent, type EventSpec } from './events.ts'
import { deepFreeze, flag, json, notFound, text, textOrNull, type Row } from './rows.ts'
import { sendsOf, upsertSend } from './sends.ts'

function toApplication(q: Queries, row: Row): Application {
  const target = json<Omit<Application['target'], 'contactId'>>(row, 'target', { to: null, url: null, contactName: null, instruction: null })
  const id = text(row, 'id')
  return deepFreeze({
    id,
    opportunityId: text(row, 'opportunity_id'),
    companyId: text(row, 'company_id'),
    channel: text(row, 'channel') as Application['channel'],
    target: { contactId: textOrNull(row, 'contact_id'), ...target },
    cvBase: textOrNull(row, 'cv_base') as Application['cvBase'],
    state: text(row, 'state') as Application['state'],
    outcome: textOrNull(row, 'outcome') as Application['outcome'],
    rewriteFrom: textOrNull(row, 'rewrite_from') as Application['rewriteFrom'],
    holdUntil: textOrNull(row, 'hold_until'),
    version: Number(row.version),
    sends: sendsOf(q, id),
    notes: text(row, 'notes'),
    test: row.test === 1,
    warnings: json(row, 'warnings', []),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  })
}

export const getApplication = (q: Queries, id: string): Application | undefined => {
  const row = q.get<Row>('SELECT * FROM applications WHERE id = ?', id)
  return row === undefined ? undefined : toApplication(q, row)
}

/** `seed_key = '<file>#<N>'` (requirements crit. 10): what keeps a second import from duplicating. */
export const applicationBySeedKey = (q: Queries, seedKey: string): Application | undefined => {
  const row = q.get<Row>('SELECT * FROM applications WHERE seed_key = ?', seedKey)
  return row === undefined ? undefined : toApplication(q, row)
}

export function applicationsByState(q: Queries, states: readonly Application['state'][]): readonly Application[] {
  const marks = states.map(() => '?').join(', ')
  return q.all<Row>(`SELECT * FROM applications WHERE state IN (${marks}) ORDER BY rowid`, ...states).map((row) => toApplication(q, row))
}

const targetJson = (app: Application): string =>
  JSON.stringify({ to: app.target.to, url: app.target.url, contactName: app.target.contactName, instruction: app.target.instruction })

export function insertApplication(q: Queries, app: Application, extra: { readonly seedKey: string | null }, event: EventSpec, now: Date): void {
  q.run(
    `INSERT INTO applications (id, opportunity_id, company_id, contact_id, seed_key, channel, target, cv_base, state, outcome, rewrite_from,
       hold_until, version, notes, warnings, test, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    app.id,
    app.opportunityId,
    app.companyId,
    app.target.contactId,
    extra.seedKey,
    app.channel,
    targetJson(app),
    app.cvBase,
    app.state,
    app.outcome,
    app.rewriteFrom,
    app.holdUntil,
    app.version,
    app.notes,
    JSON.stringify(app.warnings),
    flag(app.test),
    app.createdAt,
    app.updatedAt,
  )
  for (const send of app.sends) upsertSend(q, app.id, send)
  appendEvent(q, { ...event, applicationId: app.id, companyId: app.companyId }, now)
}

/** Writes an application moved by `appTransition` — its row and every one of its sends — with its event. */
export function saveApplication(q: Queries, app: Application, event: EventSpec, now: Date): Result<void> {
  const updated = q.run(
    `UPDATE applications SET contact_id = ?, channel = ?, target = ?, cv_base = ?, state = ?, outcome = ?, rewrite_from = ?, hold_until = ?,
       version = ?, notes = ?, warnings = ?, updated_at = ? WHERE id = ?`,
    app.target.contactId,
    app.channel,
    targetJson(app),
    app.cvBase,
    app.state,
    app.outcome,
    app.rewriteFrom,
    app.holdUntil,
    app.version,
    app.notes,
    JSON.stringify(app.warnings),
    app.updatedAt,
    app.id,
  )
  if (updated.changes === 0) return notFound('application')
  for (const send of app.sends) upsertSend(q, app.id, send)
  appendEvent(q, { ...event, applicationId: app.id, companyId: app.companyId }, now)
  return ok(undefined)
}

export const companyOf = (q: Queries, applicationId: string): string | null =>
  textOrNull(q.get<Row>('SELECT company_id FROM applications WHERE id = ?', applicationId) ?? {}, 'company_id')
