/**
 * Reading the replies in the module's mailbox, READ-ONLY (design D12 «Leer»; tasks Q1; ADR-0018;
 * guardrail 11).
 *
 * TWO LOCKS ON «THE MAILBOX DOES NOT CHANGE», as in the inbox: `mailboxOpen` with `readOnly: true`
 * sends EXAMINE, and every part is fetched with `BODY.PEEK`. `ImapClient` declares no method that
 * writes. The protocol test (`read.protocol.test.ts`) pins what the real imapflow sends.
 *
 * THE WINDOW: `min(lastReplyPoll, replyBackfillFrom) − 1 day`; the first time (no `lastReplyPoll`), the
 * oldest `sends` row − 1 day — not «today»: wave 1 goes out before Q. Nothing ever sent and nothing
 * read: no IMAP at all. ALWAYS BY UID.
 *
 * WHAT IS READ: envelope, flags, `internalDate` and the headers `message-id`, `in-reply-to`,
 * `references`, `from`, `list-id`; THE BODY ONLY OF WHAT MATCHED (rules 1–3, `match.ts`), one
 * `BODY.PEEK[n]<0.64 KiB>` per part number, cut to `MAX_BODY_CHARS` by `plainText`. An unmatched mail
 * is never read past its headers. A mail in `mail_seen` (by `UIDVALIDITY:UID` or by `Message-ID`), or
 * whose `classify` work is still queued, is skipped: nothing is processed twice.
 *
 * WHAT IS WRITTEN, in ONE `tx` after a read that worked: `lastReplyPoll` = the read's instant,
 * `replyBackfillFrom` deleted (v4 C1), the IGNORED mails (rule 4, not a job's subject) marked seen,
 * and whatever the caller's `handle` writes (Q5: the unmatched recorded, the matched submitted to
 * classification and held). Everything else comes back to the caller too; it is marked seen when
 * applied. The window also stays open behind `replyHoldFrom` (Q5): the earliest mail still waiting
 * for its classification.
 *
 * NOTHING THROWS OUT OF HERE, and NOTHING IS LOGGED: a reply's body, subject or address never reaches
 * a log line. A failure is `{ ok: false, reason }`, and the reason never carries the password nor the
 * user.
 */

import type { Timers } from '@factotum/core'
import {
  closeQuietly,
  decodePart,
  imapOptions,
  parseHeaderBlock,
  pickPart,
  plainText,
  reasonOf,
  untilAborted,
  type ConnectImap,
  type FetchMessageObject,
  type ImapClient,
  type MetaQuery,
  type PickedPart,
} from '@factotum/mail'
import type { Db, Queries } from '../store/db.ts'
import { ok, type Result } from '../types.ts'
import { markMailSeen, mailSeen, pendingClassifyRefs, replyClocks, replyWorld, saveReplyPoll, type ReplyClocks } from '../store/repo.ts'
import { HUMAN_REPLY_CLASSES, matchReply, messageIdsIn, type MatchMail, type MatchWorld, type ReplyMatch } from './match.ts'

/** What one read may cost: a server that does not answer costs this, not the tick. */
export const READ_TIMEOUT_MS = 90_000
/** Per part, cut at the server (D12: 64 KiB). */
export const MAX_REPLY_PART_BYTES = 64 * 1024
/** design D12 «Leer». */
export const REPLY_HEADERS: readonly string[] = ['message-id', 'in-reply-to', 'references', 'from', 'list-id']

const DAY_MS = 24 * 60 * 60 * 1000
/** A hostile subject or display name must not grow a prompt or an event without end. */
const SUBJECT_MAX = 300
const FROM_MAX = 200

export interface ReadInput {
  readonly db: Db
  /** `mail.imapHost` and `mail.address`. */
  readonly server: { readonly host: string; readonly user: string }
  /** Read from its file by the caller, at every read. */
  readonly password: string
  readonly connect: ConnectImap
  /** The kernel's, for the cap: a test can advance it. */
  readonly timers: Timers
  /** `stop()`'s. */
  readonly signal: AbortSignal
  readonly now: () => Date
  /** A test cannot wait ninety seconds. */
  readonly timeoutMs?: number
  /**
   * What the caller does with the replies (Q5: record the unmatched, submit the matched to
   * classification), INSIDE the read's own `tx`: the poll is saved with them, or neither is.
   * `waiting`: how many mails this read left to a `classify` work still queued or running — their
   * work may have ended since, with nothing applied, so the caller must not let the window close.
   */
  readonly handle?: (q: Queries, replies: readonly ReadReply[], pollAt: Date, waiting: number) => Result<void>
}

/** One mail that needs the caller: matched (rules 1–3, with its body) or unmatched (rule 4, without). */
export interface ReadReply {
  /** `<UIDVALIDITY>:<UID>`: the `mail_seen` key, and the `classify` work's `ref`. */
  readonly key: string
  readonly uidValidity: number
  readonly uid: number
  readonly messageId: string | null
  /** «Name <address>», cut. */
  readonly from: string
  /** Lower case. */
  readonly fromAddress: string
  readonly subject: string
  /** ISO: the date OF THE MAIL (its `Date`, else when the server got it). */
  readonly date: string
  /** ISO: when the server got it (`INTERNALDATE`, what `SEARCH SINCE` reads). */
  readonly receivedAt: string
  /** `https://mail.google.com/mail/u/<user>/#all/<X-GM-MSGID in hex>`, when the server gave the id. */
  readonly gmailLink: string | null
  /** It carries a `List-Id`: a mailing list wrote it. */
  readonly list: boolean
  readonly match: Exclude<ReplyMatch, { readonly kind: 'ignored' }>
  /** ≤ MAX_BODY_CHARS; `''` when unmatched. IN MEMORY ONLY: to Claude by stdin, never to disk nor a log. */
  readonly body: string
}

export type ReadResult =
  | { readonly ok: true; readonly replies: readonly ReadReply[]; readonly since: string | null; readonly pollAt: string }
  | { readonly ok: false; readonly reason: string }

/** The start of the window, or null when nothing was ever sent nor read (D12; v4 C1). Pure. */
export function sinceOf(clocks: ReplyClocks): string | null {
  const from = clocks.lastPoll === undefined ? clocks.oldestSend : clocks.lastPoll
  const starts = [from, clocks.backfill, clocks.hold].filter((at): at is string => at !== undefined)
  if (starts.length === 0) return null
  const earliest = starts.reduce((a, b) => (a < b ? a : b))
  return new Date(new Date(earliest).getTime() - DAY_MS).toISOString()
}

export async function readReplies(input: ReadInput): Promise<ReadResult> {
  const pollAt = input.now()
  const since = input.db.read((q) => sinceOf(replyClocks(q)))
  if (input.signal.aborted) return { ok: false, reason: 'stopped' }
  if (since === null) return { ok: true, replies: [], since: null, pollAt: pollAt.toISOString() }

  const timeoutMs = input.timeoutMs ?? READ_TIMEOUT_MS
  const own = new AbortController()
  const timer = input.timers.setTimeout(() => own.abort(), timeoutMs)
  const signal = AbortSignal.any([input.signal, own.signal])
  let client: ImapClient | undefined
  const onAbort = (): void => client?.close()
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    client = input.connect(imapOptions(input.server, input.password))
    const read = await session(client, input, new Date(since), pollAt, signal)
    if (!read.ok) return read
    return save(input, read.value, pollAt, since)
  } catch (error) {
    if (signal.aborted) return { ok: false, reason: own.signal.aborted ? `no answer within ${Math.round(timeoutMs / 1000)} s` : 'stopped' }
    return { ok: false, reason: reasonOf(error, { user: input.server.user, password: input.password }) }
  } finally {
    timer[Symbol.dispose]()
    await closeQuietly(client, signal.aborted, input.timers)
    signal.removeEventListener('abort', onAbort)
  }
}

interface Session {
  readonly replies: readonly ReadReply[]
  readonly ignored: readonly Described[]
  /** Mails left to a `classify` work still pending when they were read. */
  readonly waiting: number
}

type Step = <T>(work: Promise<T>) => Promise<T>

async function session(client: ImapClient, input: ReadInput, since: Date, now: Date, signal: AbortSignal): Promise<{ ok: true; value: Session } | { ok: false; reason: string }> {
  const step: Step = async (work) => {
    const value = await untilAborted(work, signal)
    signal.throwIfAborted()
    return value
  }
  await step(client.connect())
  const opened = await step(client.mailboxOpen('INBOX', { readOnly: true }))
  const uidValidity = uidValidityOf(opened)
  if (uidValidity === undefined) return { ok: false, reason: 'the server gave no UIDVALIDITY for INBOX' }
  const uids = await step(client.search({ since }, { uid: true }))
  if (uids === false || uids === undefined || uids.length === 0) return { ok: true, value: { replies: [], ignored: [], waiting: 0 } }

  const query: MetaQuery = { envelope: true, flags: true, bodyStructure: true, internalDate: true, headers: [...REPLY_HEADERS] }
  const messages = await step(client.fetchAll(uids.join(','), query, { uid: true }))
  const { fresh, waiting, world } = input.db.read((q) => {
    const pending = pendingClassifyRefs(q)
    const described = messages.flatMap((m) => describe(m, uidValidity, input.server.user))
    const unseen = described.filter((d) => !mailSeen(q, d.key, d.mail.messageId))
    const fresh = unseen.filter((d) => !pending.has(d.key))
    return { fresh, waiting: unseen.length - fresh.length, world: { apps: replyWorld(q, HUMAN_REPLY_CLASSES), now } satisfies MatchWorld }
  })
  const matched = fresh.map((d) => ({ ...d, match: matchReply(d.mail, world) }))
  const wanted = matched.filter((d) => d.match.kind === 'thread' || d.match.kind === 'candidates')
  const bodies = await bodiesOf(client, wanted, step)
  const replies = matched.flatMap((d): ReadReply[] => (d.match.kind === 'ignored' ? [] : [toReply(d, d.match, bodies.get(d.uid) ?? '')]))
  return { ok: true, value: { replies, ignored: matched.filter((d) => d.match.kind === 'ignored'), waiting } }
}

/** The read's `tx`: the poll, the backfill spent, the ignored ones seen, and the caller's `handle`. */
function save(input: ReadInput, read: Session, pollAt: Date, since: string): ReadResult {
  const saved = input.db.tx((q) => {
    saveReplyPoll(q, pollAt.toISOString())
    for (const d of read.ignored) markMailSeen(q, { key: d.key, uidValidity: d.uidValidity, uid: d.uid, messageId: d.mail.messageId, applicationId: null, class: 'ignored' }, pollAt)
    return input.handle === undefined ? ok(undefined) : input.handle(q, read.replies, pollAt, read.waiting)
  })
  if (!saved.ok) return { ok: false, reason: `the read could not be saved (${saved.error.reason})` }
  return { ok: true, replies: read.replies, since, pollAt: pollAt.toISOString() }
}

/**
 * ONE FETCH PER PART NUMBER (the inbox's B8 measure): `BODY.PEEK[n]<0.MAX_REPLY_PART_BYTES>` for every
 * matched mail sharing that part; the transfer encoding and the charset undone by `decodePart`.
 */
async function bodiesOf(client: ImapClient, mails: readonly Described[], step: Step): Promise<ReadonlyMap<number, string>> {
  const byPart = new Map<string, { uid: number; picked: PickedPart }[]>()
  for (const mail of mails) {
    const picked = pickPart(mail.message.bodyStructure)
    if (picked !== undefined) byPart.set(picked.part, [...(byPart.get(picked.part) ?? []), { uid: mail.uid, picked }])
  }
  const bodies = new Map<number, string>()
  for (const [part, wanted] of byPart) {
    const fetched = await step(client.fetchAll(wanted.map((w) => w.uid).join(','), { bodyParts: [{ key: part, maxLength: MAX_REPLY_PART_BYTES }] }, { uid: true }))
    const raw = new Map(fetched.map((message) => [message.uid, message.bodyParts?.get(part)]))
    for (const { uid, picked } of wanted) {
      const bytes = raw.get(uid)
      if (bytes !== undefined) bodies.set(uid, plainText(decodePart(bytes, picked), picked.kind))
    }
  }
  return bodies
}

interface Described {
  readonly key: string
  readonly uidValidity: number
  readonly uid: number
  readonly mail: MatchMail
  readonly fromDisplay: string
  readonly date: string
  readonly receivedAt: string
  readonly gmailLink: string | null
  readonly list: boolean
  readonly message: FetchMessageObject
}

function describe(message: FetchMessageObject, uidValidity: number, user: string): Described[] {
  const received = toDate(message.internalDate)
  if (received === undefined) return []
  const headers = parseHeaderBlock(message.headers?.toString('utf8') ?? '')
  const envelope = message.envelope
  const sender = envelope?.from?.[0]
  const address = (sender?.address ?? '').toLowerCase()
  const headerId = messageIdsIn(headers.get('message-id') ?? [])[0]
  return [
    {
      key: `${uidValidity}:${message.uid}`,
      uidValidity,
      uid: message.uid,
      mail: {
        messageId: envelope?.messageId ?? headerId ?? null,
        inReplyTo: messageIdsIn(headers.get('in-reply-to') ?? []),
        references: messageIdsIn(headers.get('references') ?? []),
        from: address,
        subject: cut(envelope?.subject ?? '', SUBJECT_MAX),
      },
      fromDisplay: cut(sender?.name ? `${sender.name} <${address}>` : address, FROM_MAX),
      date: (toDate(envelope?.date) ?? received).toISOString(),
      receivedAt: received.toISOString(),
      gmailLink: gmailLinkOf(message.emailId, user),
      list: headers.has('list-id'),
      message,
    },
  ]
}

function toReply(d: Described, match: ReadReply['match'], body: string): ReadReply {
  return {
    key: d.key,
    uidValidity: d.uidValidity,
    uid: d.uid,
    messageId: d.mail.messageId,
    from: d.fromDisplay,
    fromAddress: d.mail.from,
    subject: d.mail.subject,
    date: d.date,
    receivedAt: d.receivedAt,
    gmailLink: d.gmailLink,
    list: d.list,
    match,
    body,
  }
}

/** imapflow gives `uidValidity` as a bigint on the mailbox it opened. */
function uidValidityOf(opened: unknown): number | undefined {
  const value = (opened as { uidValidity?: unknown } | null)?.uidValidity
  const number = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

function gmailLinkOf(emailId: string | undefined, user: string): string | null {
  if (emailId === undefined || !/^\d+$/.test(emailId)) return null
  return `https://mail.google.com/mail/u/${encodeURIComponent(user)}/#all/${BigInt(emailId).toString(16)}`
}

function toDate(value: Date | string | undefined): Date | undefined {
  if (value === undefined) return undefined
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
