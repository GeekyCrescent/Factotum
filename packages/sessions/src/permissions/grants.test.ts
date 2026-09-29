import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Timers } from '@factotum/core'
import { createGrantTable, GRANT_TIMEOUT_MS, type GrantRequest } from './grants.ts'
import type { GrantOutcome } from '../types.ts'

/** Timers a test fires by hand: ten minutes are not waited for. */
function manualTimers(): { timers: Timers; fire: () => void; armed: () => number } {
  const due = new Map<number, () => void>()
  let next = 0
  const arm = (fn: () => void) => {
    const id = next++
    due.set(id, fn)
    return { [Symbol.dispose]: () => void due.delete(id) }
  }
  return {
    timers: { setTimeout: arm, setInterval: arm },
    fire: () => {
      for (const [id, fn] of [...due]) {
        due.delete(id)
        fn()
      }
    },
    armed: () => due.size,
  }
}

const PROJECT: GrantRequest = { kind: 'project', path: '/Users/me/web', id: 'web', name: undefined, color: 2, base: 'web' }
const approved = async (): Promise<GrantOutcome> => ({ outcome: 'approved', reason: undefined })

function table() {
  let now = Date.parse('2026-09-29T10:00:00.000Z')
  const manual = manualTimers()
  const grants = createGrantTable({ now: () => new Date(now), timers: manual.timers })
  return { grants, manual, advance: (ms: number) => void (now += ms) }
}

test('open hands back a request id, a 43-character token and a deadline ten minutes out', () => {
  const { grants } = table()
  const opened = grants.open(PROJECT)
  assert.match(opened.token, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(opened.requestId, opened.token)
  assert.equal(opened.expiresAt, new Date(Date.parse('2026-09-29T10:00:00.000Z') + GRANT_TIMEOUT_MS).toISOString())
  assert.equal(grants.pendingCount(), 1)
  assert.deepEqual(grants.status(opened.requestId), { status: 'pending', reason: undefined })
})

test('ONLY THE TOKEN ANSWERS: the request id is unknown to answer (criterion 9)', async () => {
  const { grants } = table()
  const { requestId, token } = grants.open(PROJECT)
  assert.deepEqual(await grants.answer(requestId, 'allow', approved), { outcome: 'unknown' })
  assert.deepEqual(await grants.answer(token, 'allow', approved), { outcome: 'approved', reason: undefined, first: true })
  assert.deepEqual(grants.status(requestId), { status: 'approved', reason: undefined })
})

test('TWO ANSWERS, ONE RESULT — even when the second lands while the first is still writing (criterion 9)', async () => {
  const { grants } = table()
  const { token } = grants.open(PROJECT)
  let release: () => void = () => undefined
  let applied = 0
  const slow = async (): Promise<GrantOutcome> => {
    applied += 1
    await new Promise<void>((resolve) => (release = resolve))
    return { outcome: 'approved', reason: undefined }
  }
  const first = grants.answer(token, 'allow', slow)
  const second = grants.answer(token, 'deny', slow)
  release()
  assert.deepEqual(await first, { outcome: 'approved', reason: undefined, first: true })
  assert.deepEqual(await second, { outcome: 'approved', reason: undefined, first: false })
  assert.equal(applied, 1, 'the write ran once')
})

test('AN apply THAT THROWS is `rejected` with why, for both answers (criterion 9)', async () => {
  const { grants } = table()
  const { token, requestId } = grants.open(PROJECT)
  const failing = async (): Promise<GrantOutcome> => Promise.reject(new Error('could not write projects.json: EACCES'))
  const [a, b] = await Promise.all([grants.answer(token, 'allow', failing), grants.answer(token, 'allow', failing)])
  assert.deepEqual(a, { outcome: 'rejected', reason: 'could not write projects.json: EACCES', first: true })
  assert.deepEqual(b, { outcome: 'rejected', reason: 'could not write projects.json: EACCES', first: false })
  assert.deepEqual(grants.status(requestId), { status: 'rejected', reason: 'could not write projects.json: EACCES' })
})

test('deny runs nothing and says denied', async () => {
  const { grants } = table()
  const { token, requestId } = grants.open(PROJECT)
  let ran = false
  assert.deepEqual(await grants.answer(token, 'deny', async () => ((ran = true), { outcome: 'approved', reason: undefined })), {
    outcome: 'denied',
    reason: undefined,
    first: true,
  })
  assert.equal(ran, false)
  assert.equal(grants.status(requestId).status, 'denied')
})

test('IT EXPIRES at ten minutes; THE FIRST ANSWER DISARMS the deadline (criterion 16)', async () => {
  const { grants, manual } = table()
  const late = grants.open(PROJECT)
  const quick = grants.open({ kind: 'shared', path: '/Users/me/notes', base: 'notes' })
  assert.equal(manual.armed(), 2)
  await grants.answer(quick.token, 'allow', approved)
  assert.equal(manual.armed(), 1, 'the answered one disarmed its timer')
  manual.fire()
  assert.deepEqual(grants.status(late.requestId), { status: 'expired', reason: 'nobody answered in time' })
  assert.deepEqual(await grants.answer(late.token, 'allow', approved), { outcome: 'expired' })
  assert.equal(grants.status(quick.requestId).status, 'approved', 'the fired timer did not touch the answered one')
  assert.equal(grants.pendingCount(), 0)
})

test('get reads one request by its token, then `settled`; an unknown token is undefined', async () => {
  const { grants } = table()
  const { token } = grants.open(PROJECT)
  const found = grants.get(token)
  assert.equal(typeof found === 'object' && found.kind === 'project' ? found.path : '', '/Users/me/web')
  await grants.answer(token, 'deny', approved)
  assert.equal(grants.get(token), 'settled')
  assert.equal(grants.get('x'.repeat(43)), undefined)
  assert.deepEqual(grants.status('nope'), { status: 'unknown' })
})

test('closeAll expires every waiting request with the reason — no answer outlives the engine', async () => {
  const { grants, manual } = table()
  const { token, requestId } = grants.open(PROJECT)
  grants.closeAll('the daemon was shutting down')
  assert.equal(manual.armed(), 0)
  assert.deepEqual(grants.status(requestId), { status: 'expired', reason: 'the daemon was shutting down' })
  assert.deepEqual(await grants.answer(token, 'allow', approved), { outcome: 'expired' })
})

test('settled requests older than two windows are forgotten at the next open', async () => {
  const { grants, advance } = table()
  const old = grants.open(PROJECT)
  await grants.answer(old.token, 'deny', approved)
  advance(2 * GRANT_TIMEOUT_MS + 1)
  grants.open(PROJECT)
  assert.deepEqual(grants.status(old.requestId), { status: 'unknown' })
  assert.deepEqual(await grants.answer(old.token, 'allow', approved), { outcome: 'unknown' })
})
