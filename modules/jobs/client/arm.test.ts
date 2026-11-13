import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ARM_EXPIRY_MS, ARM_GRACE_MS, isArmed, pressArmed } from './arm.ts'

const T = 50_000

test('the first click arms; it never fires', () => {
  assert.deepEqual(pressArmed(null, T), { fire: false, armedAt: T })
})

test('a double tap does not confirm: a second click inside the grace is ignored', () => {
  assert.equal(ARM_GRACE_MS, 500)
  assert.deepEqual(pressArmed(T, T + 120), { fire: false, armedAt: T })
  assert.deepEqual(pressArmed(T, T + ARM_GRACE_MS - 1), { fire: false, armedAt: T })
})

test('a second click after the grace and before the expiry fires and disarms', () => {
  assert.deepEqual(pressArmed(T, T + ARM_GRACE_MS), { fire: true, armedAt: null })
  assert.deepEqual(pressArmed(T, T + ARM_EXPIRY_MS - 1), { fire: true, armedAt: null })
})

test('an arm older than the expiry is gone: the click arms again', () => {
  assert.equal(ARM_EXPIRY_MS, 4_000)
  assert.deepEqual(pressArmed(T, T + ARM_EXPIRY_MS), { fire: false, armedAt: T + ARM_EXPIRY_MS })
})

test('a clock gone backwards never fires', () => {
  assert.deepEqual(pressArmed(T, T - 10), { fire: false, armedAt: T })
})

test('isArmed holds until the expiry', () => {
  assert.equal(isArmed(null, T), false)
  assert.equal(isArmed(T, T + 10), true)
  assert.equal(isArmed(T, T + ARM_EXPIRY_MS), false)
})
