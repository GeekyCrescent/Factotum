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
import { json, text, textOrNull, type Row } from './rows.ts'

/** `meta` keys (D12): the instant of the last read, and the backfill an import of by-hand sends leaves (S6b). */
export const LAST_REPLY_POLL = 'lastReplyPoll'
export const REPLY_BACKFILL_FROM = 'replyBackfillFrom'

/**
 * `meta` key (tasks Q5, the pending item of Q1): the earliest INTERNALDATE of a mail handed to
 * classification and not applied yet. The window never closes past it, so a mail whose classification
 * waits longer than a day (a usage limit, a logged-out CLI during an absence) and then loses its body
 * with a restart is still found by the next read.
 */
export const REPLY_HOLD_FROM = 'replyHoldFrom'

export interface ReplyClocks {
  readonly lastPoll: string | undefined
  readonly backfill: string | undefined
  /** The oldest `at` of any `sends` row: the first read starts there (D12). */
  readonly oldestSend: string | undefined
  /** `REPLY_HOLD_FROM`. */
  readonly hold?: string | undefined
}

export function replyClocks(q: Queries): ReplyClocks {
  const oldest = q.get<Row>('SELECT min(at) AS at FROM sends')
  return {
    lastPoll: getMeta(q, LAST_REPLY_POLL),
    backfill: getMeta(q, REPLY_BACKFILL_FROM),
    oldestSend: textOrNull(oldest ?? {}, 'at') ?? undefined,
    hold: getMeta(q, REPLY_HOLD_FROM),
  }
}

/** A mail received at `receivedAt` went to classification: the hold is the earliest such. */
export function holdReplies(q: Queries, receivedAt: string): void {
  const current = getMeta(q, REPLY_HOLD_FROM)
  if (current === undefined || receivedAt < current) setMeta(q, REPLY_HOLD_FROM, receivedAt)
}

/** No classification is waiting any more: the window may close again. */
export function releaseHold(q: Queries): void {
  deleteMeta(q, REPLY_HOLD_FROM)
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

/**
 * An «Unmatched reply» (design D12 rule 4, requirements crit. 56): a `reply` event with no application
 * and `data.unmatched`, that no `reply-applied { replyEventId }` has assigned or ignored yet.
 */
export interface UnmatchedReply {
  /** `<UIDVALIDITY>:<UID>`: what `POST /replies/:key/assign` names. */
  readonly key: string
  readonly eventId: string
  /** ISO: the date of the mail. */
  readonly at: string
  readonly from: string
  readonly subject: string
  readonly link: string | null
  /** Claude's class when it classified it but could not name the application; null for rule 4. */
  readonly class: string | null
  readonly summary: string | null
  /** The applications the reader matched it to (rules 1–3) when Claude could not settle it; [] for rule 4. */
  readonly candidates: readonly string[]
  /** Matched by domain or ATS, but Gmail did not vouch for the sender (D12 «Remitente verificado»). */
  readonly unverifiedSender: boolean
}

const PENDING_UNMATCHED = `e.kind = 'reply' AND e.application_id IS NULL AND json_extract(e.data, '$.unmatched') = 1
  AND NOT EXISTS (SELECT 1 FROM events a WHERE a.kind = 'reply-applied' AND json_extract(a.data, '$.replyEventId') = e.id)`

const toUnmatched = (row: Row): UnmatchedReply => {
  const data = json<Readonly<Record<string, unknown>>>(row, 'data', {})
  const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  return Object.freeze({
    key: str(data.key) ?? '',
    eventId: text(row, 'id'),
    at: text(row, 'at'),
    from: str(data.from) ?? '',
    subject: str(data.subject) ?? '',
    link: str(data.link),
    class: str(data.class),
    summary: str(data.summary),
    candidates: Array.isArray(data.candidates) ? data.candidates.filter((id): id is string => typeof id === 'string') : [],
    unverifiedSender: data.unverifiedSender === true,
  })
}

/** The «Unmatched replies» still waiting for the owner, newest first. */
export const unmatchedReplies = (q: Queries): readonly UnmatchedReply[] =>
  q.all<Row>(`SELECT e.id, e.at, e.data FROM events e WHERE ${PENDING_UNMATCHED} ORDER BY e.at DESC, e.rowid DESC`).map(toUnmatched)

/** One of them, by the mail's key; undefined when there is none waiting. */
export const unmatchedReply = (q: Queries, key: string): UnmatchedReply | undefined => {
  const row = q.get<Row>(`SELECT e.id, e.at, e.data FROM events e WHERE ${PENDING_UNMATCHED} AND json_extract(e.data, '$.key') = ?`, key)
  return row === undefined ? undefined : toUnmatched(row)
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

