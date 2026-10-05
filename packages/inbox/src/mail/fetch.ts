/**
 * Reading ONE account, read-only (spec 2026-10-05, D4; guardrail 1).
 *
 * TWO LOCKS ON "THE MAILBOX DOES NOT CHANGE": `mailboxOpen` with `readOnly: true` sends EXAMINE, and
 * imapflow fetches every part with `BODY.PEEK` (requirements §0.4). Nothing here can reach a command
 * that writes, because `ImapClient` declares none.
 *
 * ALWAYS BY UID. A sequence number from `search` reaching a fetch by UID would read another mail.
 *
 * NOTHING THROWS OUT OF HERE. Every way it can go wrong — refused login, no network, no answer within
 * ACCOUNT_TIMEOUT_MS, the run's cap — ends in `{ ok: false, reason }`, and the reason never carries
 * the password (criterion 9).
 */

import type { Timers } from '@factotum/core'
import type { AccountConfig } from '../config.ts'
import { countAttachments, decodePart, pickPart, plainText, type PickedPart } from './body.ts'
import type { ConnectImap, FetchMessageObject, ImapClient, ImapOptions, MetaQuery } from './client.ts'
import { addressesIn, parseHeaderBlock } from './headers.ts'
import { sourceOf } from './sources.ts'

/** What one account may cost a run: a server that does not answer costs this, not the run (criterion 9). */
export const ACCOUNT_TIMEOUT_MS = 90_000
/** Per part. A newsletter of several MB is not fetched whole to keep 4 000 characters (guardrail 9). */
export const MAX_PART_BYTES = 64 * 1024
/** TLS on 993, and nothing else (guardrail 6). */
export const IMAP_PORT = 993

/** `List-Unsubscribe`, and the forwarding headers measured in A5. `To` and `Cc` come in the envelope. */
const HEADERS = ['list-unsubscribe', 'resent-from', 'x-forwarded-for', 'delivered-to']
const DAY_MS = 24 * 60 * 60 * 1000
const REASON_MAX = 200
/** A hostile subject or display name must not grow the prompt or the digest without end. */
const SUBJECT_MAX = 300
const FROM_MAX = 200
/** LOGOUT is politeness: a server that does not answer it does not hold the run (or shutdown) longer. */
const LOGOUT_MAX_MS = 5_000

export interface FetchedMail {
  readonly accountId: string
  readonly sourceId: string | undefined
  readonly uid: number
  readonly messageId: string | undefined
  /** X-GM-MSGID, decimal, as imapflow returns it. For the link. */
  readonly gmailId: string | undefined
  readonly from: string
  readonly subject: string
  /** ISO. */
  readonly date: string
  readonly unsubscribe: boolean
  readonly attachments: number
  /** ≤ MAX_BODY_CHARS. IN MEMORY ONLY: it goes to claude by stdin and never to disk (guardrail 4). */
  readonly body: string
}

export interface FetchInput {
  readonly account: AccountConfig
  readonly password: string
  readonly since: Date
  /** The run's: its global cap (D2). */
  readonly signal: AbortSignal
  readonly connect: ConnectImap
  /** The kernel's, for the per-account cap: a test can advance it, `AbortSignal.timeout` it could not. */
  readonly timers: Timers
  /** Bodies are fetched for the newest this many eligible mails only; the rest would not be classified. */
  readonly maxBodies: number
  /** A test cannot wait ninety seconds. */
  readonly timeoutMs?: number
}

export type FetchResult = { readonly ok: true; readonly mails: readonly FetchedMail[] } | { readonly ok: false; readonly reason: string }

/** The six options measured in A1, and nothing a config can change. */
export function imapOptions(account: AccountConfig, password: string): ImapOptions {
  return {
    host: account.host,
    port: IMAP_PORT,
    secure: true,
    auth: { user: account.user, pass: password },
    // Otherwise pino writes to the daemon's stdout, with subjects in it (criterion 27).
    logger: false,
    disableAutoIdle: true,
    disableCompression: true,
    disableBinary: true,
    disableAutoEnable: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  }
}

export async function fetchAccount(input: FetchInput): Promise<FetchResult> {
  const timeoutMs = input.timeoutMs ?? ACCOUNT_TIMEOUT_MS
  const own = new AbortController()
  const timer = input.timers.setTimeout(() => own.abort(), timeoutMs)
  const signal = AbortSignal.any([input.signal, own.signal])
  let client: ImapClient | undefined
  const onAbort = (): void => client?.close()
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    if (signal.aborted) return { ok: false, reason: stoppedReason(own.signal, timeoutMs) }
    client = input.connect(imapOptions(input.account, input.password))
    const mails = await read(client, input, signal)
    return { ok: true, mails }
  } catch (error) {
    if (signal.aborted) return { ok: false, reason: stoppedReason(own.signal, timeoutMs) }
    return { ok: false, reason: reasonOf(error, input) }
  } finally {
    timer[Symbol.dispose]()
    await closeQuietly(client, signal.aborted, input.timers)
    signal.removeEventListener('abort', onAbort)
  }
}

async function read(client: ImapClient, input: FetchInput, signal: AbortSignal): Promise<readonly FetchedMail[]> {
  const step = async <T>(work: Promise<T>): Promise<T> => {
    const value = await untilAborted(work, signal)
    signal.throwIfAborted()
    return value
  }

  await step(client.connect())
  await step(client.mailboxOpen('INBOX', { readOnly: true }))
  // IMAP's SINCE knows days, not times, and the server's day may not be ours: ask from the day
  // before and keep the window exactly in memory, by INTERNALDATE.
  const uids = await step(client.search({ since: new Date(input.since.getTime() - DAY_MS) }, { uid: true }))
  if (uids === false || uids === undefined || uids.length === 0) return []

  const query: MetaQuery = { envelope: true, flags: true, bodyStructure: true, internalDate: true, headers: HEADERS }
  const messages = await step(client.fetchAll(uids.join(','), query, { uid: true }))

  const eligible = messages
    .map((message) => describe(message, input))
    .filter((mail): mail is Described => mail !== undefined && mail.receivedAt >= input.since.getTime())
    .filter((mail) => mail.rule === 'all' || !mail.seen)
    .sort((a, b) => b.receivedAt - a.receivedAt)

  const bodies = await bodiesOf(client, eligible.slice(0, input.maxBodies), step)
  return eligible.map((mail) => ({ ...mail.fetched, body: bodies.get(mail.fetched.uid) ?? '' }))
}

/**
 * ONE FETCH PER PART NUMBER, not one `download()` per mail (measured in B8, tasks §M): Gmail answers
 * each command in about half a second, so 41 mails cost 41 s one by one and under 2 s together.
 * `BODY.PEEK[n]<0.MAX_PART_BYTES>`: peeked, and capped at the server (guardrail 9). The transfer
 * encoding and the charset are undone by `decodePart`, since a fetched part arrives as is.
 */
async function bodiesOf(
  client: ImapClient,
  mails: readonly Described[],
  step: <T>(work: Promise<T>) => Promise<T>,
): Promise<ReadonlyMap<number, string>> {
  const byPart = new Map<string, { uid: number; picked: PickedPart }[]>()
  for (const mail of mails) {
    const picked = pickPart(mail.message.bodyStructure)
    if (picked === undefined) continue
    byPart.set(picked.part, [...(byPart.get(picked.part) ?? []), { uid: mail.message.uid, picked }])
  }
  const bodies = new Map<number, string>()
  for (const [part, wanted] of byPart) {
    const fetched = await step(
      client.fetchAll(wanted.map((mail) => mail.uid).join(','), { bodyParts: [{ key: part, maxLength: MAX_PART_BYTES }] }, { uid: true }),
    )
    const raw = new Map(fetched.map((message) => [message.uid, message.bodyParts?.get(part)]))
    for (const { uid, picked } of wanted) {
      const bytes = raw.get(uid)
      if (bytes !== undefined) bodies.set(uid, plainText(decodePart(bytes, picked), picked.kind))
    }
  }
  return bodies
}

interface Described {
  readonly fetched: Omit<FetchedMail, 'body'>
  readonly receivedAt: number
  readonly seen: boolean
  readonly rule: 'unread' | 'all'
  readonly message: FetchMessageObject
}

function describe(message: FetchMessageObject, input: FetchInput): Described | undefined {
  const received = toDate(message.internalDate)
  if (received === undefined) return undefined
  const headers = parseHeaderBlock(message.headers?.toString('utf8') ?? '')
  const envelope = message.envelope
  const source = sourceOf(
    {
      resentFrom: addressesIn(headers.get('resent-from')),
      forwardedFor: addressesIn(headers.get('x-forwarded-for')),
      deliveredTo: addressesIn(headers.get('delivered-to')),
      to: (envelope?.to ?? []).flatMap((address) => (address.address === undefined ? [] : [address.address.toLowerCase()])),
      cc: (envelope?.cc ?? []).flatMap((address) => (address.address === undefined ? [] : [address.address.toLowerCase()])),
    },
    input.account.sources,
    input.account.user,
  )
  const sender = envelope?.from?.[0]
  return {
    receivedAt: received.getTime(),
    seen: message.flags?.has('\\Seen') ?? false,
    rule: source?.read ?? input.account.read,
    message,
    fetched: {
      accountId: input.account.id,
      sourceId: source?.id,
      uid: message.uid,
      messageId: envelope?.messageId,
      gmailId: message.emailId,
      from: cut(sender === undefined ? '' : sender.name ? `${sender.name} <${sender.address ?? ''}>` : (sender.address ?? ''), FROM_MAX),
      subject: cut(envelope?.subject ?? '', SUBJECT_MAX),
      date: (toDate(envelope?.date) ?? received).toISOString(),
      unsubscribe: headers.has('list-unsubscribe'),
      attachments: countAttachments(message.bodyStructure),
    },
  }
}

/**
 * A closed socket does not always settle what was waiting on it, so every wait also ends when the
 * signal fires. The work left behind is dropped; its rejection is swallowed here, not unhandled.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined)
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Aborted: `onAbort` already closed it, at the instant of the abort. Otherwise LOGOUT, politely — but
 * bounded: past LOGOUT_MAX_MS the socket is dropped. The abort listener is still on meanwhile, so the
 * run's cap or `stop()` also cuts it.
 */
async function closeQuietly(client: ImapClient | undefined, aborted: boolean, timers: Timers): Promise<void> {
  if (client === undefined || aborted) return
  let timer: Disposable | undefined
  const late = new Promise<void>((resolve) => {
    timer = timers.setTimeout(resolve, LOGOUT_MAX_MS)
  })
  try {
    await Promise.race([client.logout().catch(() => undefined), late])
  } finally {
    timer?.[Symbol.dispose]()
    try {
      client.close()
    } catch {
      // Already closed: the outcome that was wanted.
    }
  }
}

function stoppedReason(own: AbortSignal, timeoutMs: number): string {
  return own.aborted ? `no answer within ${Math.round(timeoutMs / 1000)} s` : 'stopped'
}

/** The server's words or Node's code — never the password, and the user name masked. */
function reasonOf(error: unknown, input: FetchInput): string {
  const record = (error ?? {}) as { authenticationFailed?: unknown; response?: unknown; code?: unknown; message?: unknown }
  const words =
    typeof record.response === 'string' && record.response !== ''
      ? record.response
      : typeof record.code === 'string'
        ? record.code
        : typeof record.message === 'string'
          ? record.message
          : 'unknown error'
  const prefix = record.authenticationFailed === true ? 'login refused: ' : ''
  const masked = mask(mask(words, input.password, '***'), input.account.user, '<user>')
  return `${prefix}${masked}`.slice(0, REASON_MAX)
}

function toDate(value: Date | string | undefined): Date | undefined {
  if (value === undefined) return undefined
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function mask(text: string, secret: string, as: string): string {
  return secret === '' ? text : text.split(secret).join(as)
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
