import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { AUTH_PAUSE_MS, MAX_ATTEMPTS, PAUSED_UNTIL, RETRY_DELAYS_MS } from '../ai/queue.ts'
import { AUTH_REASON, LIMIT_REASON } from '../ai/run.ts'
import { insertApp, queueStore, rig, workOf } from '../ai/test-queue.ts'
import { FAKE_CLAUDE, runDir, scriptClaude } from '../build/test-builder.ts'
import type { Db, Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { NOW, send, valueOf } from '../test-state.ts'
import { capturedLog, eventually, realTimers, tempBase } from '../test-support.ts'
import { fail, ok, type Result } from '../types.ts'
import { classifyInputOf, classifyReply, createClassifier, verdictOf, type ClassifyDeps, type ClassifyInput, type ClassifyVerdict, type ReplyJob } from './classify.ts'
import type { ReadReply } from './read.ts'

const ctx = { signal: new AbortController().signal, timeoutMs: 30_000 }
const SENT_AT = '2026-11-10T00:00:00.000Z'

const INPUT: ClassifyInput = {
  from: 'Ada Lovelace <ada@acme.example>',
  subject: 'Re: Application',
  body: 'Can we talk on Monday?',
  candidates: [
    { applicationId: 'app-1', company: 'Acme', role: 'Graduate engineer', sentAt: SENT_AT },
    { applicationId: 'app-2', company: 'Acme', role: 'Data analyst', sentAt: SENT_AT },
  ],
}

function deps(stateDir: string, over: Partial<ClassifyDeps> = {}): ClassifyDeps {
  return { stateDir, now: () => NOW, timers: realTimers, log: capturedLog().log, claude: { model: 'haiku', effort: undefined, bin: FAKE_CLAUDE }, ...over }
}

const calls = (stateDir: string): number => {
  const file = join(runDir(stateDir), 'fake-claude.calls')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').length : 0
}

function reply(over: Partial<ReadReply> = {}): ReadReply {
  return {
    key: '7:11',
    uidValidity: 7,
    uid: 11,
    messageId: '<r1@acme.example>',
    from: 'Ada Lovelace <ada@acme.example>',
    fromAddress: 'ada@acme.example',
    subject: 'Re: Application',
    date: '2026-11-13T05:00:00.000Z',
    receivedAt: '2026-11-13T05:00:00.000Z',
    gmailLink: null,
    list: false,
    match: { kind: 'thread', rule: 1, applicationId: 'app-1', sendKind: 'initial', viaAttempt: false, messageId: '<m1@jobs.factotum.local>' },
    body: 'Can we talk on Monday?',
    ...over,
  }
}

// ── One run ──────────────────────────────────────────────────────────────────────────────────────

test('Q3: one run on the classify model, by stdin, no system file; the short id comes back as the application’s id', async () => {
  using base = tempBase()
  scriptClaude(base.dir, ['ok'], [{ class: 'interview', application: 'a1', summary: 'Asks for a call on Monday.' }])

  const result = await classifyReply(deps(base.dir), INPUT, ctx)

  assert.ok(result.ok)
  assert.deepEqual(result.verdict, { class: 'interview', applicationId: 'app-2', summary: 'Asks for a call on Monday.' })
  const args = JSON.parse(readFileSync(join(runDir(base.dir), 'fake-claude.args.1'), 'utf8')) as string[]
  assert.equal(args[args.indexOf('--model') + 1], 'haiku')
  assert.equal(args.includes('--append-system-prompt-file'), false)
  assert.equal(args[args.indexOf('--tools') + 1], '')
  const stdin = readFileSync(join(runDir(base.dir), 'fake-claude.prompt.1'), 'utf8')
  assert.ok(stdin.includes('<application id="a0"><company>Acme</company><role>Graduate engineer</role>'))
  assert.ok(stdin.includes('<body>Can we talk on Monday?</body>'))
})

test('Q3: an id that is not on the list is discarded — the class stays, the application is null', async () => {
  using base = tempBase()
  scriptClaude(base.dir, ['ok'], [{ class: 'rejection', application: 'a7', summary: 'Not progressing.' }])
  const result = await classifyReply(deps(base.dir), INPUT, ctx)
  assert.deepEqual(result.ok && result.verdict, { class: 'rejection', applicationId: null, summary: 'Not progressing.' })
})

test('Q3: a class out of the closed list is outside the schema: a failed run', async () => {
  using base = tempBase()
  scriptClaude(base.dir, ['ok'], [{ class: 'hired', application: 'a0', summary: '' }])
  assert.deepEqual(await classifyReply(deps(base.dir), INPUT, ctx), { ok: false, kind: 'failed', reason: 'claude answered outside the schema' })
})

test('Q3: a usage limit and a logged-out CLI come back as such, for the queue to pause', async () => {
  using base = tempBase()
  scriptClaude(base.dir, ['limit-exit1', 'auth'])
  const limit = await classifyReply(deps(base.dir), INPUT, ctx)
  const auth = await classifyReply(deps(base.dir), INPUT, ctx)
  assert.deepEqual([limit.ok || limit.kind, limit.ok || limit.reason], ['limit', LIMIT_REASON])
  assert.deepEqual(auth, { ok: false, kind: 'auth', reason: AUTH_REASON })
})

test('Q3: no candidate at all is not sent to Claude', async () => {
  using base = tempBase()
  assert.deepEqual(await classifyReply(deps(base.dir), { ...INPUT, candidates: [] }, ctx), { ok: false, kind: 'failed', reason: 'no candidate application to classify against' })
  assert.equal(calls(base.dir), 0)
})

test('verdictOf maps a short id to its application, an unknown or null one to null', () => {
  assert.equal(verdictOf({ class: 'offer', application: 'a0', summary: 's' }, INPUT.candidates).applicationId, 'app-1')
  assert.equal(verdictOf({ class: 'offer', application: null, summary: 's' }, INPUT.candidates).applicationId, null)
  assert.equal(verdictOf({ class: 'offer', application: 'app-1', summary: 's' }, INPUT.candidates).applicationId, null)
})

// ── What goes to Claude, from the store ──────────────────────────────────────────────────────────

async function store(base: { dir: string }): Promise<Db> {
  const db = await queueStore({ dir: base.dir, [Symbol.dispose]: () => undefined })
  insertApp(db, { id: 'app-1', state: 'sent', sends: [send({ state: 'sent', at: SENT_AT })] })
  insertApp(db, { id: 'app-2', state: 'sent', sends: [send({ state: 'sent', messageId: '<m2@jobs.factotum.local>', at: '2026-11-11T00:00:00.000Z' })] })
  return db
}

test('classifyInputOf: a thread reply has its one application; a domain/ATS one its candidates; an unmatched one none', async () => {
  using base = tempBase()
  const db = await store(base)
  const thread = db.read((q) => classifyInputOf(q, reply()))
  assert.deepEqual(thread, { from: 'Ada Lovelace <ada@acme.example>', subject: 'Re: Application', body: 'Can we talk on Monday?', candidates: [{ applicationId: 'app-1', company: 'Acme', role: 'Graduate engineer', sentAt: SENT_AT }] })

  const several = db.read((q) => classifyInputOf(q, reply({ match: { kind: 'candidates', rule: 3, applicationIds: ['app-2', 'gone', 'app-1'] } })))
  assert.deepEqual(several?.candidates.map((c) => [c.applicationId, c.sentAt]), [['app-2', '2026-11-11T00:00:00.000Z'], ['app-1', SENT_AT]], 'an application that is gone is left out')

  assert.equal(db.read((q) => classifyInputOf(q, reply({ match: { kind: 'unmatched', rule: 4 }, body: '' }))), undefined)
})

// ── Through the queue's interactive lane ─────────────────────────────────────────────────────────

interface Applied {
  readonly job: ReplyJob
  readonly verdict: ClassifyVerdict
}

function classifierRig(db: Db, stateDir: string, refuse: (call: number) => boolean = () => false) {
  const applied: Applied[] = []
  const log = capturedLog()
  let calls = 0
  const apply = (_q: Queries, job: ReplyJob, verdict: ClassifyVerdict): Result<void> => {
    calls += 1
    // A refused apply: the queue's return `tx` rolls back with it.
    if (refuse(calls)) return fail('module-error', 'the apply rolled back')
    applied.push({ job, verdict })
    return ok(undefined)
  }
  const classifier = createClassifier({ ...deps(stateDir, { log: log.log }), apply })
  const { queue, clock } = rig(db, { handlers: { classify: classifier.handler }, classifyFailed: classifier.failed })
  const submit = (job: ReplyJob): string => {
    const work = valueOf(db.tx((q) => classifier.submit(q, queue.enqueue, job)))
    queue.pump()
    return work.id
  }
  return { applied, queue, clock, submit, log, applyCalls: () => calls }
}

test('Q3 through the queue: `classify` on the interactive lane, the verdict applied in the queue’s tx, the body kept only in memory', async () => {
  using base = tempBase()
  const db = await store(base)
  scriptClaude(base.dir, ['ok'], [{ class: 'interview', application: 'a0', summary: 'Asks for a call.' }])
  const { applied, queue, submit } = classifierRig(db, base.dir)
  const input = db.read((q) => classifyInputOf(q, reply()))
  assert.ok(input)
  const job: ReplyJob = { reply: reply(), input }

  const id = submit(job)
  assert.deepEqual([workOf(db, id).kind, workOf(db, id).lane, workOf(db, id).ref], ['classify', 'interactive', '7:11'])
  await queue.settled()

  assert.equal(workOf(db, id).state, 'done')
  assert.deepEqual(applied.map((a) => [a.job.reply.key, a.verdict]), [['7:11', { class: 'interview', applicationId: 'app-1', summary: 'Asks for a call.' }]])
  const row = db.read((q) => q.get<{ ref: string; reason: string | null }>('SELECT ref, reason FROM work WHERE id = ?', id))
  assert.deepEqual(row, { ref: '7:11', reason: null }, 'the work row holds the mail key, never its text')
  assert.equal(db.read((q) => repo.pendingClassifyRefs(q)).size, 0)
})

test('Q3 through the queue: a logged-out CLI pauses the queue with no attempt; the reply is kept and classified after the pause', async () => {
  using base = tempBase()
  const db = await store(base)
  scriptClaude(base.dir, ['auth', 'ok'], [{}, { class: 'auto-ack', application: 'a0', summary: 'Received.' }])
  const { applied, queue, clock, submit } = classifierRig(db, base.dir)

  const id = submit({ reply: reply(), input: INPUT })
  await queue.settled()
  assert.deepEqual([workOf(db, id).state, workOf(db, id).attempts, applied.length], ['queued', 0, 0])
  assert.ok(db.read((q) => repo.getMeta(q, PAUSED_UNTIL)) !== undefined)
  assert.ok(db.read((q) => repo.pendingClassifyRefs(q)).has('7:11'), 'the reader leaves it to the queue meanwhile')

  clock.advance(AUTH_PAUSE_MS + 1)
  queue.pump()
  await eventually(() => workOf(db, id).state === 'done', 'classified after the pause')
  assert.deepEqual(applied.map((a) => a.verdict.class), ['auto-ack'])
})

test('Q3 through the queue: a work whose reply is no longer in memory (a restart) ends done, with no run and nothing applied', async () => {
  using base = tempBase()
  const db = await store(base)
  const { applied, queue, log } = classifierRig(db, base.dir)
  const id = valueOf(queue.add({ kind: 'classify', ref: '7:99' })).id
  await queue.settled()
  assert.equal(workOf(db, id).state, 'done')
  assert.equal(applied.length, 0)
  assert.equal(calls(base.dir), 0)
  assert.ok(log.lines.some((line) => /no longer in memory \(1 since start\)/.test(line)), 'counted, for the log')
  assert.equal(log.lines.join('\n').includes('7:99'), false, 'not even the key')
})

test('Q5: a reply whose work ended failed without the classifier being told leaves memory at the next submit', async () => {
  using base = tempBase()
  const db = await store(base)
  const classifier = createClassifier({ ...deps(base.dir), apply: () => ok(undefined) })
  const { queue } = rig(db, { handlers: { classify: classifier.handler } })
  valueOf(db.tx((q) => classifier.submit(q, queue.enqueue, { reply: reply(), input: INPUT })))
  assert.equal(classifier.holds('<r1@acme.example>'), true)

  // Failed for good on a path that never reached `failed` (its own tx rolled back: the row alone).
  db.read((q) => q.run("UPDATE work SET state = 'failed' WHERE ref = '7:11'"))
  valueOf(db.tx((q) => classifier.submit(q, queue.enqueue, { reply: reply({ key: '7:12', uid: 12, messageId: '<r2@acme.example>' }), input: INPUT })))

  assert.equal(classifier.holds('<r1@acme.example>'), false, 'dropped')
  assert.equal(classifier.holds('<r2@acme.example>'), true)
})

test('Q5: an apply whose return tx rolls back keeps the reply in memory — the retry classifies and applies it', async () => {
  using base = tempBase()
  const db = await store(base)
  scriptClaude(base.dir, ['ok', 'ok'], [
    { class: 'interview', application: 'a0', summary: 'Asks for a call.' },
    { class: 'interview', application: 'a0', summary: 'Asks for a call.' },
  ])
  const { applied, queue, clock, submit, applyCalls } = classifierRig(db, base.dir, (call) => call === 1)

  const id = submit({ reply: reply(), input: INPUT })
  await queue.settled()
  assert.deepEqual([workOf(db, id).state, workOf(db, id).attempts], ['queued', 1], 'a failed attempt, retried')
  clock.advance((RETRY_DELAYS_MS[0] ?? 0) + 1)
  queue.pump()
  await queue.settled()

  assert.equal(applyCalls(), 2)
  assert.deepEqual(applied.map((a) => [a.job.reply.key, a.verdict.class]), [['7:11', 'interview']], 'applied on the retry')
  assert.equal(workOf(db, id).state, 'done')
})

test('Q5: an apply that rolls back three times still leaves an «Unmatched reply», seen — never a mail dropped without a trace', async () => {
  using base = tempBase()
  const db = await store(base)
  scriptClaude(base.dir, ['ok', 'ok', 'ok'], [{ class: 'offer', application: 'a0', summary: 's' }, { class: 'offer', application: 'a0', summary: 's' }, { class: 'offer', application: 'a0', summary: 's' }])
  const { applied, queue, clock, submit } = classifierRig(db, base.dir, () => true)

  const id = submit({ reply: reply(), input: INPUT })
  await queue.settled()
  for (const delay of RETRY_DELAYS_MS) {
    clock.advance(delay + 1)
    queue.pump()
    await queue.settled()
  }

  assert.deepEqual([workOf(db, id).state, applied.length], ['failed', 0])
  assert.deepEqual(db.read((q) => repo.unmatchedReplies(q)).map((u) => u.key), ['7:11'])
  assert.equal(db.read((q) => repo.mailSeen(q, '7:11', null)), true)
})

test('Q5 (the pending item of Q1): a classification that fails for the third time becomes an «Unmatched reply» with its candidates, seen; the body leaves memory', async () => {
  using base = tempBase()
  const db = await store(base)
  scriptClaude(base.dir, ['garbage', 'garbage', 'garbage'])
  const { applied, queue, clock, submit } = classifierRig(db, base.dir)

  const id = submit({ reply: reply(), input: INPUT })
  await queue.settled()
  for (const delay of RETRY_DELAYS_MS) {
    clock.advance(delay + 1)
    queue.pump()
    await queue.settled()
  }

  assert.deepEqual([workOf(db, id).state, workOf(db, id).attempts, applied.length], ['failed', MAX_ATTEMPTS, 0])
  const unmatched = db.read((q) => repo.unmatchedReplies(q))
  assert.deepEqual(unmatched.map((u) => [u.key, u.from, u.subject, u.class, u.candidates]), [['7:11', 'Ada Lovelace <ada@acme.example>', 'Re: Application', null, ['app-1']]])
  assert.equal(db.read((q) => repo.mailSeen(q, '7:11', null)), true, 'the next read does not submit it again')
  assert.equal(JSON.stringify(db.read((q) => q.all('SELECT data FROM events'))).includes('Monday'), false, 'never the body')
})
