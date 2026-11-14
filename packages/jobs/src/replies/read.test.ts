import { test } from 'node:test'
import assert from 'node:assert/strict'

import { imapDouble, type FakeMail } from '@factotum/mail/testing'
import type { ConnectImap } from '@factotum/mail'
import { insertApp, queueStore } from '../ai/test-queue.ts'
import { recordSent } from '../seed/by-hand.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { NOW, send, valueOf } from '../test-state.ts'
import { realTimers, tempBase } from '../test-support.ts'
import { ok } from '../types.ts'
import { MAX_REPLY_PART_BYTES, readReplies, REPLY_HEADERS, sinceOf, type ReadInput, type ReadResult } from './read.ts'

const PASSWORD = 'abcdefghijklmnop'
const USER = 'owner.jobs@example.com'
const SENT_AT = '2026-11-10T00:00:00.000Z'
const DAY_MS = 24 * 60 * 60 * 1000

/** The double answers `mailboxOpen` without UIDVALIDITY; imapflow gives it, as a bigint. */
function withUidValidity(connect: ConnectImap, uidValidity: bigint | null = 7n): ConnectImap {
  return (options) => {
    const client = connect(options)
    return { ...client, mailboxOpen: async (path, o) => ({ ...((await client.mailboxOpen(path, o)) as object), ...(uidValidity === null ? {} : { uidValidity }) }) }
  }
}

const thread: FakeMail = {
  uid: 11,
  internalDate: new Date('2026-11-13T05:00:00.000Z'),
  from: { name: 'Ada Lovelace', address: 'ada@acme.example' },
  subject: 'Re: Application — Data Analyst',
  messageId: '<r1@acme.example>',
  emailId: '1844674407370955161',
  headers: 'In-Reply-To: <m1@jobs.factotum.local>\r\nReferences: <m1@jobs.factotum.local>\r\n\r\n',
  parts: { '1': 'Thanks, can we talk on Monday?\r\n> quoted' },
}
const unmatched: FakeMail = {
  uid: 12,
  internalDate: new Date('2026-11-13T06:00:00.000Z'),
  from: { address: 'someone@unknown.example' },
  subject: 'Your interview',
  messageId: '<r2@unknown.example>',
  parts: { '1': 'never read' },
}
const newsletter: FakeMail = {
  uid: 13,
  internalDate: new Date('2026-11-13T07:00:00.000Z'),
  from: { address: 'news@shop.example' },
  subject: 'Weekly deals',
  messageId: '<n1@shop.example>',
  headers: 'List-Id: <deals.shop.example>\r\n\r\n',
  parts: { '1': 'never read' },
}

async function store(base: { dir: string }): Promise<Db> {
  const db = await queueStore({ dir: base.dir, [Symbol.dispose]: () => undefined })
  insertApp(db, { id: 'app-1', state: 'sent', sends: [send({ state: 'sent', at: SENT_AT })] })
  return db
}

function input(db: Db, connect: ConnectImap, now: Date = NOW, over: Partial<ReadInput> = {}): ReadInput {
  return {
    db,
    server: { host: 'imap.gmail.com', user: USER },
    password: PASSWORD,
    connect,
    timers: realTimers,
    signal: new AbortController().signal,
    now: () => now,
    ...over,
  }
}

const okOf = (result: ReadResult) => {
  if (!result.ok) assert.fail(result.reason)
  return result
}
const meta = (db: Db, key: string) => db.read((q) => repo.getMeta(q, key))
const day = (value: unknown): string => (value as { since: Date }).since.toISOString().slice(0, 10)

test('Q1 first read: EXAMINE INBOX, since the oldest send − 1 day, the six headers, the body of the matched only; the poll saved', async () => {
  using base = tempBase()
  const db = await store(base)
  const double = imapDouble([thread, unmatched, newsletter])

  const read = okOf(await readReplies(input(db, withUidValidity(double.connect))))

  assert.equal(read.since, new Date(new Date(SENT_AT).getTime() - DAY_MS).toISOString())
  const calls = double.calls.map((c) => c.method)
  assert.deepEqual(calls, ['connect', 'mailboxOpen', 'search', 'fetchAll', 'fetchAll', 'logout', 'close'])
  assert.deepEqual(double.calls[1]?.args, ['INBOX', { readOnly: true }])
  assert.equal(day(double.calls[2]?.args[0]), '2026-11-09')
  assert.deepEqual(double.calls[2]?.args[1], { uid: true })
  assert.deepEqual(REPLY_HEADERS, ['message-id', 'in-reply-to', 'references', 'from', 'list-id', 'authentication-results'])
  assert.deepEqual(double.calls[3]?.args, ['11,12,13', { envelope: true, flags: true, bodyStructure: true, internalDate: true, headers: [...REPLY_HEADERS] }, { uid: true }])
  assert.equal(MAX_REPLY_PART_BYTES, 64 * 1024)
  assert.deepEqual(double.calls[4]?.args, ['11', { bodyParts: [{ key: '1', maxLength: MAX_REPLY_PART_BYTES }] }, { uid: true }], 'bodies only of what matched')

  assert.deepEqual(
    read.replies.map((r) => [r.key, r.match.kind, r.body]),
    [
      ['7:11', 'thread', 'Thanks, can we talk on Monday?'],
      ['7:12', 'unmatched', ''],
    ],
  )
  const [reply] = read.replies
  assert.deepEqual(reply?.match, { kind: 'thread', rule: 1, applicationId: 'app-1', sendKind: 'initial', viaAttempt: false, messageId: '<m1@jobs.factotum.local>' })
  assert.equal(reply?.from, 'Ada Lovelace <ada@acme.example>')
  assert.equal(reply?.fromAddress, 'ada@acme.example')
  assert.equal(reply?.date, '2026-11-13T05:00:00.000Z')
  assert.equal(reply?.receivedAt, '2026-11-13T05:00:00.000Z')
  assert.equal(reply?.messageId, '<r1@acme.example>')
  assert.equal(reply?.gmailLink, `https://mail.google.com/mail/u/${encodeURIComponent(USER)}/#all/1999999999999999`)
  assert.equal(reply?.list, false)

  assert.equal(meta(db, 'lastReplyPoll'), NOW.toISOString())
  const seen = db.read((q) => [repo.mailSeen(q, '7:13', null), repo.mailSeen(q, '7:11', null), repo.mailSeen(q, '7:12', null)])
  assert.deepEqual(seen, [true, false, false], 'the ignored one is done; the others are for Q4')
})

test('Q1 (v4 C1): a by-hand `sent` of 13-nov imported after a read of 20-nov → the next read searches from 12-nov, and does not process again what it saw', async () => {
  using base = tempBase()
  const db = await store(base)
  const nov20 = new Date('2026-11-20T00:00:00.000Z')
  const first = okOf(await readReplies(input(db, withUidValidity(imapDouble([thread, unmatched, newsletter]).connect), nov20)))
  // Q4 applies the thread reply and marks it seen in its own `tx`.
  valueOf(db.tx((q) => ok(repo.markMailSeen(q, { key: first.replies[0]!.key, uidValidity: 7, uid: 11, messageId: '<r1@acme.example>', applicationId: 'app-1', class: 'interview' }, nov20))))

  const byHand = insertApp(db, { id: 'app-2', state: 'sent', sends: [send({ channel: 'manual', messageId: null, state: 'sent', at: '2026-11-13T01:00:00.000Z' })] })
  valueOf(db.tx((q) => ok(recordSent(q, byHand, '2026-11-13T01:00:00.000Z', nov20))))
  assert.equal(meta(db, 'replyBackfillFrom'), '2026-11-13T01:00:00.000Z')

  const nov21 = new Date('2026-11-21T00:00:00.000Z')
  const double = imapDouble([thread, unmatched, newsletter])
  const second = okOf(await readReplies(input(db, withUidValidity(double.connect), nov21)))

  assert.equal(day(double.calls[2]?.args[0]), '2026-11-12')
  assert.deepEqual(second.replies.map((r) => r.key), ['7:12'], 'the thread reply and the newsletter were seen; the unmatched one is still Q4’s')
  assert.equal(meta(db, 'replyBackfillFrom'), undefined, 'cleared in the tx that saved the read')
  assert.equal(meta(db, 'lastReplyPoll'), nov21.toISOString())

  const third = imapDouble([])
  okOf(await readReplies(input(db, withUidValidity(third.connect), new Date('2026-11-21T00:10:00.000Z'))))
  assert.equal(day(third.calls[2]?.args[0]), '2026-11-20', 'back to the last read − 1 day')
})

test('Q1: a mail seen by its Message-ID is not processed again, even under another UIDVALIDITY', async () => {
  using base = tempBase()
  const db = await store(base)
  valueOf(db.tx((q) => ok(repo.markMailSeen(q, { key: '3:99', uidValidity: 3, uid: 99, messageId: '<r1@acme.example>', applicationId: 'app-1', class: 'auto-ack' }, NOW))))
  const read = okOf(await readReplies(input(db, withUidValidity(imapDouble([thread]).connect))))
  assert.deepEqual(read.replies, [])
})

test('Q1: a mail whose classification is already queued is left to it', async () => {
  using base = tempBase()
  const db = await store(base)
  const at = NOW.toISOString()
  valueOf(db.tx((q) => ok(repo.insertWork(q, { id: 'w1', kind: 'classify', ref: '7:11', lane: 'interactive', state: 'queued', attempts: 0, notBefore: null, reason: null, createdAt: at, updatedAt: at }))))
  const double = imapDouble([thread])
  const read = okOf(await readReplies(input(db, withUidValidity(double.connect))))
  assert.deepEqual(read.replies, [])
  assert.equal(double.calls.filter((c) => c.method === 'fetchAll').length, 1, 'no body fetched for it')
})

test('Q1: nothing was ever sent and nothing read → no IMAP at all, and no poll saved', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const double = imapDouble([thread])
  const read = okOf(await readReplies(input(db, withUidValidity(double.connect))))
  assert.deepEqual([read.replies, read.since, double.calls.length, meta(db, 'lastReplyPoll')], [[], null, 0, undefined])
})

test('Q1: an empty search writes the poll and fetches nothing', async () => {
  using base = tempBase()
  const db = await store(base)
  const double = imapDouble([])
  okOf(await readReplies(input(db, withUidValidity(double.connect))))
  assert.equal(double.calls.filter((c) => c.method === 'fetchAll').length, 0)
  assert.equal(meta(db, 'lastReplyPoll'), NOW.toISOString())
})

test('Q1: a refused login is a reason without the password nor the user; nothing is written', async () => {
  using base = tempBase()
  const db = await store(base)
  const double = imapDouble([thread], { refuseLogin: { response: `NO [AUTHENTICATIONFAILED] ${USER} ${PASSWORD} invalid` } })
  const read = await readReplies(input(db, withUidValidity(double.connect)))
  assert.equal(read.ok, false)
  assert.ok(!read.ok && !read.reason.includes(PASSWORD) && !read.reason.includes(USER) && read.reason.startsWith('login refused'))
  assert.equal(meta(db, 'lastReplyPoll'), undefined)
})

test('Q1: a server that does not answer costs the timeout, and the socket is dropped', async () => {
  using base = tempBase()
  const db = await store(base)
  const double = imapDouble([thread], { stall: 'search', settleOnClose: true })
  const read = await readReplies(input(db, withUidValidity(double.connect), NOW, { timeoutMs: 50 }))
  assert.deepEqual(read, { ok: false, reason: 'no answer within 0 s' })
  assert.ok(double.closed() >= 1)
})

test('Q1: a stopped read says so, and never connects when stopped before', async () => {
  using base = tempBase()
  const db = await store(base)
  const controller = new AbortController()
  controller.abort()
  const double = imapDouble([thread])
  assert.deepEqual(await readReplies(input(db, withUidValidity(double.connect), NOW, { signal: controller.signal })), { ok: false, reason: 'stopped' })
  assert.equal(double.calls.length, 0)
})

test('Q1: no UIDVALIDITY from the server is a failed read (a UID alone cannot key `mail_seen`)', async () => {
  using base = tempBase()
  const db = await store(base)
  const read = await readReplies(input(db, withUidValidity(imapDouble([thread]).connect, null)))
  assert.deepEqual(read, { ok: false, reason: 'the server gave no UIDVALIDITY for INBOX' })
  assert.equal(meta(db, 'lastReplyPoll'), undefined)
})

test('Q1: a List-Id is reported; a mail with no Message-ID is keyed by its UID only', async () => {
  using base = tempBase()
  const db = await store(base)
  const { messageId: _id, emailId: _gm, ...bare } = thread
  const listed: FakeMail = { ...bare, uid: 21, headers: `${thread.headers!.trim()}\r\nList-Id: <hr.acme.example>\r\n\r\n` }
  const read = okOf(await readReplies(input(db, withUidValidity(imapDouble([listed]).connect))))
  assert.deepEqual(read.replies.map((r) => [r.key, r.messageId, r.list, r.gmailLink]), [['7:21', null, true, null]])
})

test('sinceOf: min(lastReplyPoll, replyBackfillFrom) − 1 day; first time the oldest send − 1 day; nothing → null', () => {
  assert.equal(sinceOf({ lastPoll: '2026-11-20T00:00:00.000Z', backfill: '2026-11-13T01:00:00.000Z', oldestSend: '2026-11-01T00:00:00.000Z' }), '2026-11-12T01:00:00.000Z')
  assert.equal(sinceOf({ lastPoll: '2026-11-20T00:00:00.000Z', backfill: '2026-11-25T00:00:00.000Z', oldestSend: undefined }), '2026-11-19T00:00:00.000Z')
  assert.equal(sinceOf({ lastPoll: undefined, backfill: undefined, oldestSend: '2026-11-10T00:00:00.000Z' }), '2026-11-09T00:00:00.000Z')
  assert.equal(sinceOf({ lastPoll: undefined, backfill: '2026-11-08T00:00:00.000Z', oldestSend: '2026-11-10T00:00:00.000Z' }), '2026-11-07T00:00:00.000Z')
  assert.equal(sinceOf({ lastPoll: undefined, backfill: undefined, oldestSend: undefined }), null)
})

test('sinceOf: a hold (a mail handed to classification, not applied yet) keeps the window open behind it', () => {
  assert.equal(sinceOf({ lastPoll: '2026-11-20T00:00:00.000Z', backfill: undefined, oldestSend: undefined, hold: '2026-11-15T06:00:00.000Z' }), '2026-11-14T06:00:00.000Z')
  assert.equal(sinceOf({ lastPoll: '2026-11-20T00:00:00.000Z', backfill: undefined, oldestSend: undefined, hold: '2026-11-25T00:00:00.000Z' }), '2026-11-19T00:00:00.000Z')
})

test('Q5: `handle` gets the replies inside the read’s own tx; when it fails, the poll is not saved either', async () => {
  using base = tempBase()
  const db = await store(base)
  const seenInTx: string[] = []
  const handle: ReadInput['handle'] = (q, replies) => {
    seenInTx.push(...replies.map((r) => r.key))
    repo.setMeta(q, 'handled', 'yes')
    return ok(undefined)
  }

  const read = okOf(await readReplies(input(db, withUidValidity(imapDouble([thread, unmatched]).connect), NOW, { handle })))

  assert.deepEqual(seenInTx, ['7:11', '7:12'])
  assert.deepEqual(read.replies.map((r) => r.key), ['7:11', '7:12'])
  assert.deepEqual([meta(db, 'handled'), meta(db, 'lastReplyPoll')], ['yes', NOW.toISOString()])

  using other = tempBase()
  const db2 = await store(other)
  const failing: ReadInput['handle'] = () => ({ ok: false, error: { code: 'module-error', reason: 'boom' } })
  const failed = await readReplies(input(db2, withUidValidity(imapDouble([thread]).connect), NOW, { handle: failing }))
  assert.deepEqual(failed, { ok: false, reason: 'the read could not be saved (boom)' })
  assert.equal(meta(db2, 'lastReplyPoll'), undefined, 'rolled back with it')
})

test('Q5: the hold in `meta` is part of the window', async () => {
  using base = tempBase()
  const db = await store(base)
  valueOf(db.tx((q) => ok(repo.setMeta(q, 'lastReplyPoll', '2026-11-20T00:00:00.000Z'))))
  valueOf(db.tx((q) => ok(repo.holdReplies(q, '2026-11-15T06:00:00.000Z'))))
  valueOf(db.tx((q) => ok(repo.holdReplies(q, '2026-11-17T06:00:00.000Z'))))
  const double = imapDouble([])
  const read = okOf(await readReplies(input(db, withUidValidity(double.connect), new Date('2026-11-21T00:00:00.000Z'))))
  assert.equal(read.since, '2026-11-14T06:00:00.000Z', 'the earliest hold, − 1 day')
  valueOf(db.tx((q) => ok(repo.releaseHold(q))))
  assert.equal(meta(db, repo.REPLY_HOLD_FROM), undefined)
})
