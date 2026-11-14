/** Profile versions (design D7: never rewritten, a NEW version each save) and the owner's rules. */

import type { ProfileVersion, Rule } from '../../types.ts'
import { ok, type Result } from '../../types.ts'
import type { Queries } from '../db.ts'
import { appendEvent, withData, type EventSpec } from './events.ts'
import { deepFreeze, flag, json, notFound, text, type Row } from './rows.ts'

/** Never rewrites: a profile is saved as a NEW version (design D7). */
export function insertProfileVersion(q: Queries, saved: ProfileVersion, event: EventSpec, now: Date): void {
  q.run('INSERT INTO profile_versions (version, created_at, data) VALUES (?, ?, ?)', saved.version, saved.createdAt, JSON.stringify(saved.profile))
  appendEvent(q, { ...withData(event, { version: saved.version }), applicationId: null, companyId: null }, now)
}

export function latestProfileVersion(q: Queries): ProfileVersion | undefined {
  const row = q.get<Row>('SELECT * FROM profile_versions ORDER BY version DESC LIMIT 1')
  if (row === undefined) return undefined
  return deepFreeze({ version: Number(row.version), createdAt: text(row, 'created_at'), profile: json(row, 'data', {}) as ProfileVersion['profile'] })
}

const toRule = (row: Row): Rule =>
  deepFreeze({
    id: text(row, 'id'),
    text: text(row, 'text'),
    scope: text(row, 'scope') as Rule['scope'],
    enabled: row.enabled === 1,
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  })

export const listRules = (q: Queries): readonly Rule[] => q.all<Row>('SELECT * FROM rules ORDER BY created_at, rowid').map(toRule)

export const getRule = (q: Queries, id: string): Rule | undefined => {
  const row = q.get<Row>('SELECT * FROM rules WHERE id = ?', id)
  return row === undefined ? undefined : toRule(row)
}

export function insertRule(q: Queries, rule: Rule, event: EventSpec, now: Date): void {
  q.run(
    'INSERT INTO rules (id, text, scope, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    rule.id,
    rule.text,
    rule.scope,
    flag(rule.enabled),
    rule.createdAt,
    rule.updatedAt,
  )
  appendEvent(q, { ...withData(event, { ruleId: rule.id }), applicationId: null, companyId: null }, now)
}

export function updateRule(q: Queries, rule: Rule, event: EventSpec, now: Date): Result<void> {
  const updated = q.run('UPDATE rules SET text = ?, scope = ?, enabled = ?, updated_at = ? WHERE id = ?', rule.text, rule.scope, flag(rule.enabled), rule.updatedAt, rule.id)
  if (updated.changes === 0) return notFound('rule')
  appendEvent(q, { ...withData(event, { ruleId: rule.id }), applicationId: null, companyId: null }, now)
  return ok(undefined)
}

/** One saved profile version (the one a send recorded at step 1, D9). */
export function profileVersionOf(q: Queries, version: number): ProfileVersion | undefined {
  const row = q.get<Row>('SELECT * FROM profile_versions WHERE version = ?', version)
  if (row === undefined) return undefined
  return deepFreeze({ version: Number(row.version), createdAt: text(row, 'created_at'), profile: json(row, 'data', {}) as ProfileVersion['profile'] })
}
