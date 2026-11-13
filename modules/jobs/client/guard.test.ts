import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SETTLE_MS, canDecide, settleLeft } from './guard.ts'

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
