/**
 * The queries of reading replies (design D12 «Leer»; tasks Q1): the clocks of the read in `meta`, what
 * was seen in `mail_seen`, and the world the matcher reads.
 *
 * `mail_seen` is not entity state and carries no event: it is the reader's memory of what it already
 * handled, keyed by `UIDVALIDITY:UID` and also found by `Message-ID`, so nothing is processed twice.
 * It never holds a subject, an address or a body.
 */

import type { Application } from '../../types.ts'
import type { Queries } from '../db.ts'
import { getApplication } from './applications.ts'
import { deleteMeta, getMeta, setMeta } from './meta.ts'
import { text, textOrNull, type Row } from './rows.ts'

/** `meta` keys (D12): the instant of the last read, and the backfill an import of by-hand sends leaves (S6b). */
export const LAST_REPLY_POLL = 'lastReplyPoll'
export const REPLY_BACKFILL_FROM = 'replyBackfillFrom'

export interface ReplyClocks {
  readonly lastPoll: string | undefined
  readonly backfill: string | undefined
  /** The oldest `at` of any `sends` row: the first read starts there (D12). */
  readonly oldestSend: string | undefined
}

export function replyClocks(q: Queries): ReplyClocks {
  const oldest = q.get<Row>('SELECT min(at) AS at FROM sends')
  return { lastPoll: getMeta(q, LAST_REPLY_POLL), backfill: getMeta(q, REPLY_BACKFILL_FROM), oldestSend: textOrNull(oldest ?? {}, 'at') ?? undefined }
}

/** The read is saved: its instant, and the backfill is spent (v4 C1: in the same `tx`). */
export function saveReplyPoll(q: Queries, at: string): void {
  setMeta(q, LAST_REPLY_POLL, at)
  deleteMeta(q, REPLY_BACKFILL_FROM)
}

export interface SeenMail {
  /** `<UIDVALIDITY>:<UID>`. */
  readonly key: string
  readonly uidValidity: number
  readonly uid: number
  readonly messageId: string | null
  readonly applicationId: string | null
  /** The class it was given (`interview`…), `unmatched`, `ignored`; never its text. */
  readonly class: string | null
}

/** Whether this mail was handled: by its key, or by its `Message-ID` under any key. */
export function mailSeen(q: Queries, key: string, messageId: string | null): boolean {
  const row =
    messageId === null
      ? q.get<Row>('SELECT 1 AS hit FROM mail_seen WHERE key = ?', key)
      : q.get<Row>('SELECT 1 AS hit FROM mail_seen WHERE key = ? OR message_id = ?', key, messageId)
  return row !== undefined
}

/** Writes it handled. A second write of the same key keeps the first. */
export function markMailSeen(q: Queries, seen: SeenMail, now: Date): void {
  q.run(
    'INSERT INTO mail_seen (key, uidvalidity, uid, message_id, seen_at, application_id, class) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING',
    seen.key,
    seen.uidValidity,
    seen.uid,
    seen.messageId,
    now.toISOString(),
    seen.applicationId,
    seen.class,
  )
}

/** The refs (mail keys) of the `classify` works still queued or running: the reader leaves them to it. */
export function pendingClassifyRefs(q: Queries): ReadonlySet<string> {
  const rows = q.all<Row>("SELECT ref FROM work WHERE kind = 'classify' AND state IN ('queued', 'running')")
  return new Set(rows.map((row) => text(row, 'ref')))
}

/** An application as the matcher reads it (`replies/match.ts`, `MatchApp`). */
export interface ReplyWorldApp {
  readonly application: Application
  readonly domain: string | null
  readonly lastHumanReplyAt: string | null
}

/**
 * Every application with a row in `sends`, oldest first, with its company's domain and the `at` of its
 * latest `reply` whose `data.class` is one of `humanClasses` (the matcher's last activity, v6 M5).
 */
export function replyWorld(q: Queries, humanClasses: readonly string[]): readonly ReplyWorldApp[] {
  const marks = humanClasses.map(() => '?').join(', ')
  const human = humanClasses.length === 0 ? 'NULL' : `(SELECT max(e.at) FROM events e WHERE e.application_id = a.id AND e.kind = 'reply' AND json_extract(e.data, '$.class') IN (${marks}))`
  const rows = q.all<Row>(
    `SELECT a.id AS id, c.domain AS domain, ${human} AS human
       FROM applications a JOIN companies c ON c.id = a.company_id
      WHERE EXISTS (SELECT 1 FROM sends s WHERE s.application_id = a.id)
      ORDER BY a.created_at, a.id`,
    ...humanClasses,
  )
  return rows.flatMap((row) => {
    const application = getApplication(q, text(row, 'id'))
    if (application === undefined) return []
    return [Object.freeze({ application, domain: textOrNull(row, 'domain'), lastHumanReplyAt: textOrNull(row, 'human') })]
  })
}

