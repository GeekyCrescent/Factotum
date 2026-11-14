/** Opportunities: the ads and the outreach targets (design D3). */

import type { Opportunity } from '../../types.ts'
import { ok, type Result } from '../../types.ts'
import type { Queries } from '../db.ts'
import { appendEvent, withData, type EventSpec } from './events.ts'
import { deepFreeze, json, notFound, numberOrNull, text, textOrNull, type Row } from './rows.ts'

export function insertOpportunity(q: Queries, opportunity: Opportunity, dedupeKey: string, event: EventSpec, now: Date): void {
  const o = opportunity
  const data = { startsAt: o.startsAt, duration: o.duration, hours: o.hours, salary: o.salary, requirements: o.requirements, remote: o.remote }
  q.run(
    `INSERT INTO opportunities (id, company_id, kind, title, goal_id, url, dedupe_key, source, source_ref, posted_at, closes_at, score,
       breakdown, profile_version, status, discard_reason, checked_at, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    o.id,
    o.companyId,
    o.kind,
    o.title,
    o.goalId,
    o.url,
    dedupeKey,
    o.source,
    o.sourceRef,
    o.postedAt,
    o.closesAt,
    o.score,
    o.breakdown === null ? null : JSON.stringify(o.breakdown),
    o.profileVersion,
    o.status,
    o.discardReason,
    o.checkedAt,
    JSON.stringify(data),
  )
  appendEvent(q, { ...withData(event, { opportunityId: o.id }), applicationId: null, companyId: o.companyId }, now)
}

export function getOpportunity(q: Queries, id: string): Opportunity | undefined {
  const row = q.get<Row>('SELECT * FROM opportunities WHERE id = ?', id)
  if (row === undefined) return undefined
  const data = json<Pick<Opportunity, 'startsAt' | 'duration' | 'hours' | 'salary' | 'requirements' | 'remote'>>(row, 'data', {
    startsAt: null,
    duration: null,
    hours: null,
    salary: null,
    requirements: '',
    remote: null,
  })
  return deepFreeze({
    id: text(row, 'id'),
    companyId: text(row, 'company_id'),
    kind: text(row, 'kind') as Opportunity['kind'],
    title: text(row, 'title'),
    goalId: textOrNull(row, 'goal_id'),
    url: textOrNull(row, 'url'),
    postedAt: textOrNull(row, 'posted_at'),
    closesAt: textOrNull(row, 'closes_at'),
    ...data,
    score: numberOrNull(row, 'score'),
    breakdown: json(row, 'breakdown', null),
    profileVersion: numberOrNull(row, 'profile_version'),
    source: text(row, 'source') as Opportunity['source'],
    sourceRef: textOrNull(row, 'source_ref'),
    status: text(row, 'status') as Opportunity['status'],
    discardReason: textOrNull(row, 'discard_reason'),
    checkedAt: textOrNull(row, 'checked_at'),
  })
}

export const opportunityIdByDedupeKey = (q: Queries, dedupeKey: string): string | undefined => {
  const row = q.get<Row>('SELECT id FROM opportunities WHERE dedupe_key = ?', dedupeKey)
  return row === undefined ? undefined : text(row, 'id')
}

/** The live-ad check (N3): only `checked_at` and `status` change. */
export function saveOpportunityCheck(q: Queries, opportunity: Opportunity, event: EventSpec, now: Date): Result<void> {
  const updated = q.run('UPDATE opportunities SET checked_at = ?, status = ? WHERE id = ?', opportunity.checkedAt, opportunity.status, opportunity.id)
  if (updated.changes === 0) return notFound('opportunity')
  appendEvent(q, { ...withData(event, { opportunityId: opportunity.id }), applicationId: null, companyId: opportunity.companyId }, now)
  return ok(undefined)
}
