import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Timers } from '@factotum/core'
import { createBatchTable } from './batches.ts'
import type { Question } from './shape.ts'

/** Timers that fire only when told to. A test of an hour-long window cannot wait an hour. */
function manualTimers() {
  const pending = new Set<() => void>()
  const timers: Timers = {
    setInterval: () => ({ [Symbol.dispose]: () => undefined }),
    setTimeout: (fn) => {
      pending.add(fn)
      return { [Symbol.dispose]: () => void pending.delete(fn) }
    },
  }
  const fireAll = () => {
    for (const fn of [...pending]) {
      pending.delete(fn)
      fn()
    }
  }
  return { timers, fireAll, armed: () => pending.size }
}

const questions: readonly Question[] = [
  { id: 'q1', text: 'Which colour?', options: [{ id: 'o1', label: 'red' }, { id: 'o2', label: 'green' }], multiple: false },
]
const request = (sessionId = 's1') => ({ sessionId, siteId: 'demo', questions, task: undefined })
const chosen = [{ question: 'q1', kind: 'chosen' as const, options: ['o2'] }]

function table(now = () => new Date('2026-10-01T00:00:00Z')) {
  const t = manualTimers()
  return { t, batches: createBatchTable({ now, timers: t.timers, timeoutMs: 1000 }) }
}

test('a batch the owner answers resolves with the answers, and disarms its timer', async () => {
  const { t, batches } = table()
  const { token, outcome } = batches.open(request())

  assert.deepEqual(batches.answer(token, chosen), { kind: 'answered' })
  assert.deepEqual(await outcome, { kind: 'answered', answers: chosen })
  assert.equal(t.armed(), 0)
})

test('a batch nobody answers expires when its timer fires (criterion 16)', async () => {
  const { t, batches } = table()
  const { outcome } = batches.open(request())
  t.fireAll()
  assert.deepEqual(await outcome, { kind: 'expired' })
})

test('answering twice is idempotent: the second changes nothing (criterion 15)', async () => {
  const { batches } = table()
  const { token, outcome } = batches.open(request())
  batches.answer(token, chosen)
  assert.deepEqual(batches.answer(token, [{ question: 'q1', kind: 'none' }]), { kind: 'already' })
  assert.deepEqual(await outcome, { kind: 'answered', answers: chosen })
})

test('answering after it expired says expired; an unknown token says unknown', () => {
  const { t, batches } = table()
  const { token } = batches.open(request())
  t.fireAll()
  assert.deepEqual(batches.answer(token, chosen), { kind: 'expired' })
  assert.deepEqual(batches.answer('nope', chosen), { kind: 'unknown' })
})

test('closeSession cancels SYNCHRONOUSLY only that session, and returns what it closed (criterion 21)', async () => {
  const { t, batches } = table()
  const mine = batches.open(request('s1'))
  const other = batches.open(request('s2'))

  const closed = batches.closeSession('s1')

  assert.deepEqual(closed.map((b) => b.id), [mine.id])
  assert.deepEqual(await mine.outcome, { kind: 'cancelled' })
  assert.equal(batches.list().length, 1)
  assert.equal(batches.list()[0]?.id, other.id)
  // A late answer is told it was CANCELLED — not "expired", which is what the ask table would say.
  assert.deepEqual(batches.answer(mine.token, chosen), { kind: 'cancelled' })
  assert.equal(t.armed(), 1)
})

test('closeAll shuts every batch down and returns them (criterion 22)', async () => {
  const { t, batches } = table()
  const a = batches.open(request('s1'))
  const b = batches.open(request('s2'))

  const closed = batches.closeAll('factotum stopped')

  assert.equal(closed.length, 2)
  assert.deepEqual(await a.outcome, { kind: 'shutdown', reason: 'factotum stopped' })
  assert.deepEqual(await b.outcome, { kind: 'shutdown', reason: 'factotum stopped' })
  assert.deepEqual(batches.answer(a.token, chosen), { kind: 'cancelled' })
  assert.equal(t.armed(), 0)
})

test('get gives the live batch with its siteId, or HOW it ended', () => {
  const { t, batches } = table()
  const answered = batches.open(request())
  const expired = batches.open(request())
  const cancelled = batches.open(request('s2'))
  const live = batches.open(request('s3'))

  assert.deepEqual(batches.get(live.token), {
    id: live.id,
    sessionId: 's3',
    siteId: 'demo',
    questions,
    task: undefined,
    deadlineAt: '2026-10-01T00:00:01.000Z',
  })

  batches.answer(answered.token, chosen)
  batches.closeSession('s2')
  // Firing every timer expires `expired` (and `live`); the two that had already settled keep their way.
  t.fireAll()

  assert.deepEqual(batches.get(answered.token), { over: 'answered' })
  assert.deepEqual(batches.get(expired.token), { over: 'expired' })
  assert.deepEqual(batches.get(cancelled.token), { over: 'cancelled' })
  assert.equal(batches.get('nope'), undefined)
})

test('the token is 43 base64url characters; the public id is 32 hex; they are not the same thing (criterion 27)', () => {
  const { batches } = table()
  const { token, id } = batches.open(request())
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.match(id, /^[0-9a-f]{32}$/)
  assert.notEqual(token, id)
})

test('list never returns a token (criterion 27)', () => {
  const { batches } = table()
  const { token } = batches.open(request())
  assert.ok(!JSON.stringify(batches.list()).includes(token))
})

test('the deadline is now plus the window', () => {
  const { batches } = table()
  assert.equal(batches.open(request()).deadlineAt, '2026-10-01T00:00:01.000Z')
})

test('settled tokens older than two windows are forgotten', () => {
  let now = new Date('2026-10-01T00:00:00Z')
  const { t, batches } = table(() => now)
  const old = batches.open(request())
  t.fireAll()
  now = new Date('2026-10-01T00:00:05Z')
  batches.open(request()) // opening prunes
  assert.equal(batches.get(old.token), undefined)
})
