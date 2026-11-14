/**
 * What was sent by hand (design D8 step 8; tasks S6b) — v7: the GENERIC FALLBACK line only.
 *
 * An entry carrying `**Sent by hand:** YYYY-MM-DD` enters `sent` instead of `draft` (T-A19 + T-S9): a
 * manual `initial` row with no messageId, `at` = noon of that day in `jobs.timeZone` (the follow-up
 * clock runs from there), and the events `imported` + `sent { kind: 'initial', manual: true, byHand:
 * true }` with that `at`. An entry imported before and not sent yet goes `sent` the same way, in a
 * `tx` of its own; one that already has a row in `sends` is not touched.
 *
 * A `sent` older than the last read of the mailbox leaves `meta.replyBackfillFrom` (the earliest), so
 * the replies that came between the send and the import are still read (D12 «Leer», Q1).
 */

import { appTransition } from '../state.ts'
import type { Db, Queries } from '../store/db.ts'
import { appendEvent, applicationBySeedKey, getMeta, saveApplication, setMeta } from '../store/repo.ts'
import { isCalendarDate } from '../shape.ts'
import { fail, ok, type Application, type Result } from '../types.ts'

export type ByHandResult = 'sent' | 'already-sent' | 'closed' | 'invalid'

export const INVALID_DAY = 'sent-by-hand is not a past day, YYYY-MM-DD'

const NOON = 12

/** The offset of a zone at an instant, in ms (what the wall clock reads minus UTC). */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant))
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - instant
}

/** 12:00 of `day` (YYYY-MM-DD) on the wall clock of `timeZone`. */
export function noonIn(day: string, timeZone: string): Date {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number)
  const wall = Date.UTC(year, month - 1, date, NOON)
  const first = wall - offsetAt(wall, timeZone)
  return new Date(wall - offsetAt(first, timeZone))
}

/** Today, YYYY-MM-DD, on the wall clock of `timeZone`. */
export const todayIn = (now: Date, timeZone: string): string => new Intl.DateTimeFormat('en-CA', { timeZone }).format(now)

/** The instant of a mark, or null when it is not a real day up to today in the zone. */
export function byHandAt(raw: string, timeZone: string, now: Date): string | null {
  if (!isCalendarDate(raw) || raw > todayIn(now, timeZone)) return null
  return noonIn(raw, timeZone).toISOString()
}

/** What the mark would do to an application imported before. */
export function resultFor(existing: Application, now: Date): Exclude<ByHandResult, 'invalid'> {
  if (existing.sends.length > 0) return 'already-sent'
  return appTransition(existing, { type: 'sent-by-hand' }, now).ok ? 'sent' : 'closed'
}

/** T-A19 + T-S9, with the row's `at` the day of the mark rather than the moment of the import. */
export function sentByHand(app: Application, at: string, now: Date): Result<Application> {
  const moved = appTransition(app, { type: 'sent-by-hand' }, now)
  if (!moved.ok) return moved
  return ok({ ...moved.value, sends: moved.value.sends.map((s) => (s.kind === 'initial' ? { ...s, at } : s)) })
}

const SENT_DATA = { kind: 'initial', manual: true, byHand: true } as const

/** The `sent` event, at the day of the mark, and the backfill of the replies read since. */
export function recordSent(q: Queries, app: Application, at: string, now: Date): void {
  appendEvent(q, { kind: 'sent', at, data: SENT_DATA, applicationId: app.id, companyId: app.companyId }, now)
  backfill(q, at)
}

function backfill(q: Queries, at: string): void {
  const lastPoll = getMeta(q, 'lastReplyPoll')
  if (lastPoll === undefined || at >= lastPoll) return
  const current = getMeta(q, 'replyBackfillFrom')
  setMeta(q, 'replyBackfillFrom', current !== undefined && current < at ? current : at)
}

/** An application imported before, moved to `sent` in its own `tx`. */
export function markImportedSent(db: Db, seedKey: string, at: string, now: Date): Result<Application> {
  return db.tx((q) => {
    const app = applicationBySeedKey(q, seedKey)
    if (app === undefined) return fail('not-found', `no application ${seedKey}`)
    if (app.sends.length > 0) return fail('conflict', 'it already has a send')
    const moved = sentByHand(app, at, now)
    if (!moved.ok) return moved
    saveApplication(q, moved.value, { kind: 'sent', at, data: SENT_DATA }, now)
    backfill(q, at)
    return moved
  })
}
