import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGuard } from './guard.ts'

function clock(start = 1_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => void (t += ms) }
}

test('a tap whose pointerdown came BEFORE 300 ms since the sheet showed does not answer (criterion 21)', () => {
  const c = clock()
  const guard = createGuard(c.now)
  guard.shown()
  assert.equal(guard.accepts(c.now() + 299), false)
})

test('a tap whose pointerdown came at or after 300 ms answers', () => {
  const c = clock()
  const guard = createGuard(c.now)
  guard.shown()
  assert.equal(guard.accepts(c.now() + 300), true)
  assert.equal(guard.accepts(c.now() + 5_000), true)
})

test('the keyboard (a click with no pointerdown) always answers, before and after 300 ms', () => {
  const c = clock()
  const guard = createGuard(c.now)
  guard.shown()
  assert.equal(guard.accepts(undefined), true)
  c.advance(1_000)
  assert.equal(guard.accepts(undefined), true)
})

test('a pointer before the sheet is even shown does not answer', () => {
  const guard = createGuard(clock().now)
  assert.equal(guard.accepts(10_000), false)
})
