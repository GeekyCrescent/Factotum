import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Timers } from '@factotum/core'
import { createAskTable } from './asks.ts'

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

const request = { sessionId: 's1', toolName: 'Write', target: '/etc/hosts' }

test('an ask the owner ALLOWS resolves as allowed, and disarms its timer', async () => {
  const t = manualTimers()
  const table = createAskTable({ now: () => new Date(), timers: t.timers, timeoutMs: 1000 })
  const { id, outcome } = table.open(request)

  assert.deepEqual(table.answer(id, 'allow'), { kind: 'answered' })
  assert.deepEqual(await outcome, { kind: 'answered', decision: 'allow' })
  assert.equal(t.armed(), 0)
})

test('an ask nobody answers EXPIRES when its timer fires', async () => {
  const t = manualTimers()
  const table = createAskTable({ now: () => new Date(), timers: t.timers, timeoutMs: 1000 })
  const { outcome } = table.open(request)

  t.fireAll()

  assert.deepEqual(await outcome, { kind: 'expired' })
})

test('answering twice is IDEMPOTENT: the second one changes nothing and does not throw (criterion 20)', async () => {
  const t = manualTimers()
  const table = createAskTable({ now: () => new Date(), timers: t.timers, timeoutMs: 1000 })
  const { id, outcome } = table.open(request)

  table.answer(id, 'allow')
  assert.deepEqual(table.answer(id, 'deny'), { kind: 'already' })
  assert.deepEqual(await outcome, { kind: 'answered', decision: 'allow' })
})

test('answering AFTER it expired is refused as expired, not as unknown (criterion 21)', () => {
  const t = manualTimers()
  const table = createAskTable({ now: () => new Date(), timers: t.timers, timeoutMs: 1000 })
  const { id } = table.open(request)
  t.fireAll()

  assert.deepEqual(table.answer(id, 'allow'), { kind: 'expired' })
})

test('an id that was never issued is unknown — there is no default ask', () => {
  const table = createAskTable({ now: () => new Date(), timers: manualTimers().timers, timeoutMs: 1000 })
  assert.deepEqual(table.answer('made-up', 'allow'), { kind: 'unknown' })
})

test('TWO asks are independent: answering one leaves the other waiting (criterion 19)', async () => {
  const t = manualTimers()
  const table = createAskTable({ now: () => new Date(), timers: t.timers, timeoutMs: 1000 })
  const first = table.open({ ...request, sessionId: 'a' })
  const second = table.open({ ...request, sessionId: 'b' })

  table.answer(first.id, 'deny')

  assert.deepEqual(await first.outcome, { kind: 'answered', decision: 'deny' })
  assert.deepEqual(table.list().map((a) => a.sessionId), ['b'])
  table.answer(second.id, 'allow')
  assert.deepEqual(await second.outcome, { kind: 'answered', decision: 'allow' })
})

test('closeAll resolves everything pending as a shutdown, and nothing is left armed', async () => {
  const t = manualTimers()
  const table = createAskTable({ now: () => new Date(), timers: t.timers, timeoutMs: 1000 })
  const a = table.open(request)
  const b = table.open(request)

  table.closeAll('the daemon was shutting down')

  assert.deepEqual(await a.outcome, { kind: 'shutdown', reason: 'the daemon was shutting down' })
  assert.deepEqual(await b.outcome, { kind: 'shutdown', reason: 'the daemon was shutting down' })
  assert.equal(t.armed(), 0)
  assert.deepEqual(table.list(), [])
})

test('THE ID IS A CAPABILITY: high-entropy, base64url, and never the same twice (spec §5)', () => {
  // Not a UUIDv7: those are ordered by time and half predictable. This id is what authorises
  // an answer, so it must not be guessable.
  const table = createAskTable({ now: () => new Date(), timers: manualTimers().timers, timeoutMs: 1000 })
  const ids = new Set<string>()
  for (let i = 0; i < 200; i++) {
    const { id } = table.open(request)
    assert.match(id, /^[A-Za-z0-9_-]{43}$/, '32 random bytes in base64url')
    ids.add(id)
  }
  assert.equal(ids.size, 200)
})

test('list() carries the deadline, and never the id — it is for screens and logs', () => {
  const at = new Date('2026-09-16T12:00:00.000Z')
  const table = createAskTable({ now: () => at, timers: manualTimers().timers, timeoutMs: 60_000 })
  const { id } = table.open(request)

  const [listed] = table.list()
  assert.equal(listed?.deadlineAt, '2026-09-16T12:01:00.000Z')
  assert.equal(JSON.stringify(table.list()).includes(id), false)
})
