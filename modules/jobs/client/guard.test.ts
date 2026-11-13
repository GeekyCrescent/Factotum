import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReviewItem } from './contract.ts'
import { SETTLE_MS, canDecide, createLock, decisionOn, settleLeft, viewOf } from './guard.ts'

// ── What was seen is what is approved (D15 «Lo que se vio es lo que se aprueba») ─────────────────

test('a card just shown refuses Approve and Skip for SETTLE_MS', () => {
  const shownAt = 10_000
  assert.equal(SETTLE_MS, 700)
  assert.equal(canDecide(shownAt, shownAt), false)
  assert.equal(canDecide(shownAt, shownAt + SETTLE_MS - 1), false)
  assert.equal(canDecide(shownAt, shownAt + SETTLE_MS), true)
  assert.equal(canDecide(shownAt, shownAt + 5_000), true)
})

test('a clock that went backwards does not unlock the card', () => {
  assert.equal(canDecide(10_000, 9_000), false)
})

test('settleLeft says how long until the card takes a decision', () => {
  assert.equal(settleLeft(1_000, 1_000), SETTLE_MS)
  assert.equal(settleLeft(1_000, 1_500), 200)
  assert.equal(settleLeft(1_000, 9_000), 0)
})

// ── One decision in flight ───────────────────────────────────────────────────────────────────────

test('a second decision in the same frame is refused while the first is in flight', async () => {
  const lock = createLock()
  let release: (value: string) => void = () => undefined
  const first = lock.run(() => new Promise<string>((resolve) => (release = resolve)))
  const second = lock.run(async () => 'second')
  assert.notEqual(first, null)
  assert.equal(second, null)
  assert.equal(lock.held(), true)
  release('first')
  assert.equal(await first, 'first')
  assert.equal(lock.held(), false)
  assert.equal(await lock.run(async () => 'third'), 'third')
})

test('a decision that throws still releases the lock, and the error reaches the caller', async () => {
  const lock = createLock()
  await assert.rejects(lock.run(async () => Promise.reject(new Error('boom'))) ?? Promise.resolve(), /boom/)
  assert.equal(lock.held(), false)
})

test('a callback that throws synchronously still releases the lock', async () => {
  const lock = createLock()
  await assert.rejects(lock.run(() => { throw new Error('sync') }) ?? Promise.resolve(), /sync/)
  assert.equal(lock.held(), false)
})

// ── The card that was seen (`seen`, D15) ─────────────────────────────────────────────────────────

const proposal = (seen: string, itemId = 'i-1'): ReviewItem => ({ itemId, seen, kind: 'proposal', proposalId: 'p' })

test('the view changes with the item AND with what its card shows', () => {
  assert.equal(viewOf(proposal('v1')), viewOf(proposal('v1')))
  assert.notEqual(viewOf(proposal('v1')), viewOf(proposal('v2')))
  assert.notEqual(viewOf(proposal('v1', 'i-1')), viewOf(proposal('v1', 'i-2')))
  assert.equal(viewOf(undefined), '')
})

test('every decision carries the item and the seen of the card on screen', () => {
  assert.deepEqual(decisionOn(proposal('v7'), { kind: 'approve' }), { kind: 'approve', itemId: 'i-1', seen: 'v7' })
  assert.deepEqual(decisionOn(proposal('v7'), { kind: 'skip', reason: 'not-now' }), { kind: 'skip', reason: 'not-now', itemId: 'i-1', seen: 'v7' })
})
