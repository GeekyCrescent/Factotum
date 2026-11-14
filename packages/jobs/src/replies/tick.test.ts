import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { ConnectImap, PasswordResult } from '@factotum/mail'
import { imapDouble, type FakeMail } from '@factotum/mail/testing'
import { insertApp, queueStore, rig } from '../ai/test-queue.ts'
import type { Db, Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { NOW, send } from '../test-state.ts'
import { capturedLog, manualClock, realTimers, tempBase } from '../test-support.ts'
import type { Result } from '../types.ts'
import type { ReplyJob } from './classify.ts'
import { createReplyTask, READ_FAILURES_FLAG, REPLY_READ_FAILING, type ReplyTaskDeps } from './tick.ts'

const PASSWORD = 'abcdefghijklmnop'
const USER = 'owner.jobs@example.com'
const SENT_AT = '2026-11-10T00:00:00.000Z'
const MINUTE = 60_000

function withUidValidity(connect: ConnectImap): ConnectImap {
  return (options) => {
    const client = connect(options)
    return { ...client, mailboxOpen: async (path, o) => ({ ...((await client.mailboxOpen(path, o)) as object), uidValidity: 7n }) }
  }
}

const thread: FakeMail = {
  uid: 11,
  internalDate: new Date('2026-11-13T05:00:00.000Z'),
  from: { name: 'Ada Lovelace', address: 'ada@acme.example' },
  subject: 'Re: Application',
  messageId: '<r1@acme.example>',
  headers: 'In-Reply-To: <m1@jobs.factotum.local>\r\n\r\n',
  parts: { '1': 'Can we talk on Monday?' },
}
const unmatched: FakeMail = {
  uid: 12,
  internalDate: new Date('2026-11-13T06:00:00.000Z'),
  from: { address: 'someone@unknown.example' },
  subject: 'Your interview',
  messageId: '<r2@unknown.example>',
  parts: { '1': 'never read' },
}

async function store(base: { dir: string }): Promise<Db> {
  const db = await queueStore({ dir: base.dir, [Symbol.dispose]: () => undefined })
  insertApp(db, { id: 'app-1', state: 'sent', sends: [send({ state: 'sent', at: SENT_AT })] })
  return db
}

interface Harness {
  readonly deps: ReplyTaskDeps
  readonly clock: ReturnType<typeof manualClock>
  readonly log: ReturnType<typeof capturedLog>
  readonly submitted: ReplyJob[]
  readonly passwordReads: () => number
  readonly pumps: () => number
}

function harness(db: Db, connect: ConnectImap, over: Partial<ReplyTaskDeps> = {}): Harness {
  const clock = manualClock(NOW)
  const log = capturedLog()
  const { queue } = rig(db)
  const submitted: ReplyJob[] = []
  let reads = 0
  let pumps = 0
  const deps: ReplyTaskDeps = {
    db,
    now: clock.now,
    timers: realTimers,
    log: log.log,
    pollMinutes: 10,
    server: { host: 'imap.gmail.com', user: USER },
    passwordFile: '/secret/gmail-jobs',
    readPassword: async (): Promise<PasswordResult> => {
      reads += 1
      return { ok: true, password: PASSWORD }
    },
    connect: withUidValidity(connect),
    classifier: {
      submit: (q: Queries, enqueue, job): Result<repo.Work> => {
        submitted.push(job)
        return enqueue(q, { kind: 'classify', ref: job.reply.key, lane: 'interactive' })
      },
    },
    enqueue: queue.enqueue,
    pump: () => {
      pumps += 1
    },
    ...over,
  }
  return { deps, clock, log, submitted, passwordReads: () => reads, pumps: () => pumps }
}

const meta = (db: Db, key: string) => db.read((q) => repo.getMeta(q, key))

test('Q5: a round reads, records the unmatched, submits the matched with a hold, and pumps — in one tx with the poll', async () => {
  using base = tempBase()
  const db = await store(base)
  const double = imapDouble([thread, unmatched])
  const h = harness(db, double.connect)
  const task = createReplyTask(h.deps)
  assert.equal(h.passwordReads(), 0, 'never at construction')

  await task.run()

  assert.equal(h.passwordReads(), 1, 'read inside the task, at every read')
  assert.deepEqual(h.submitted.map((j) => [j.reply.key, j.input.candidates.map((c) => c.applicationId)]), [['7:11', ['app-1']]])
  assert.deepEqual(db.read((q) => [...repo.pendingClassifyRefs(q)]), ['7:11'])
  assert.deepEqual(db.read((q) => repo.unmatchedReplies(q)).map((u) => [u.key, u.subject]), [['7:12', 'Your interview']])
  assert.equal(meta(db, repo.REPLY_HOLD_FROM), '2026-11-13T05:00:00.000Z')
  assert.equal(meta(db, 'lastReplyPoll'), NOW.toISOString())
  assert.equal(h.pumps(), 1)
})

test('Q5: every `replyPollMinutes` — a round before that reads nothing; a mail already handed over is not handed twice', async () => {
  using base = tempBase()
  const db = await store(base)
  const double = imapDouble([thread])
  const h = harness(db, double.connect)
  const task = createReplyTask(h.deps)

  await task.run()
  h.clock.advance(9 * MINUTE)
  await task.run()
  assert.equal(double.calls.filter((c) => c.method === 'connect').length, 1, 'not due yet')

  h.clock.advance(MINUTE)
  await task.run()
  assert.equal(double.calls.filter((c) => c.method === 'connect').length, 2)
  assert.equal(h.submitted.length, 1, 'its classify work is still queued: left to it')
})

test('Q5: the hold is released once no classification waits; a mail lost to a restart is found again behind it', async () => {
  using base = tempBase()
  const db = await store(base)
  const h = harness(db, imapDouble([thread]).connect)
  const task = createReplyTask(h.deps)
  await task.run()
  // A restart: the work ended `done` with its reply no longer in memory, and nothing applied.
  db.read((q) => q.run("UPDATE work SET state = 'done' WHERE kind = 'classify'"))
  // A week later: the last poll is recent, so the window alone would start long after the mail.
  h.clock.advance(7 * 24 * 60 * MINUTE)
  db.read((q) => q.run('UPDATE meta SET value = ? WHERE key = ?', new Date(h.clock.now().getTime() - 10 * MINUTE).toISOString(), 'lastReplyPoll'))
  const again = imapDouble([thread])
  await createReplyTask({ ...h.deps, connect: withUidValidity(again.connect) }).run()

  const searched = again.calls.find((c) => c.method === 'search')?.args[0] as { since: Date }
  assert.equal(searched.since.toISOString(), '2026-11-12T05:00:00.000Z', 'the hold, − 1 day, not the last poll')
  assert.deepEqual(h.submitted.map((j) => j.reply.key), ['7:11', '7:11'], 'submitted anew')
  assert.equal(meta(db, repo.REPLY_HOLD_FROM), '2026-11-13T05:00:00.000Z')
})

test('Q5: three failed reads in a row → `meta.replyReadFailing` = when the first failed; the next good read clears it; no secret in the log', async () => {
  using base = tempBase()
  const db = await store(base)
  const double = imapDouble([thread])
  let broken = true
  const refused: ConnectImap = (options) => {
    const client = double.connect(options)
    return { ...client, connect: async () => (broken ? Promise.reject(new Error(`login refused for ${USER} with ${PASSWORD}`)) : client.connect()) }
  }
  const h = harness(db, refused)
  const task = createReplyTask(h.deps)

  const first = h.clock.now().toISOString()
  for (let i = 0; i < READ_FAILURES_FLAG; i += 1) {
    assert.equal(meta(db, REPLY_READ_FAILING), undefined, `not after ${i}`)
    await task.run()
    h.clock.advance(MINUTE)
  }
  assert.equal(meta(db, REPLY_READ_FAILING), first)
  const logged = h.log.lines.join('\n')
  assert.ok(logged.includes('the mailbox could not be read'), logged)
  assert.equal(logged.includes(PASSWORD), false)
  assert.equal(logged.includes(USER), false)

  broken = false
  await task.run()
  assert.equal(meta(db, REPLY_READ_FAILING), undefined)
})

test('Q5: a password that cannot be read is a failed read, said without the path; nothing connects', async () => {
  using base = tempBase()
  const db = await store(base)
  const double = imapDouble([thread])
  const h = harness(db, double.connect, { readPassword: async () => ({ ok: false, reason: 'password file is missing' }) })
  await createReplyTask(h.deps).run()
  assert.equal(double.calls.length, 0)
  assert.ok(h.log.lines.some((line) => line.includes('password file is missing')))
  assert.equal(h.log.lines.join('\n').includes('/secret/gmail-jobs'), false)
})

test('Q5: `stop` aborts a read under way', async () => {
  using base = tempBase()
  const db = await store(base)
  const double = imapDouble([thread], { stall: 'search', settleOnClose: true })
  const h = harness(db, double.connect)
  const task = createReplyTask(h.deps)
  const running = task.run()
  await new Promise((resolve) => setImmediate(resolve))
  task.stop()
  await running
  assert.equal(meta(db, 'lastReplyPoll'), undefined)
  assert.equal(meta(db, REPLY_READ_FAILING), undefined, 'a stop is not a failure')
})
