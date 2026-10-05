import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NAME } from '@factotum/sessions'
import { INVOKABLE_NAME } from '@factotum/modules'

/**
 * The name rule exists twice because `modules/` cannot import `packages/sessions` (CLAUDE.md §1).
 * This is the one place that can see both, so it is where they are tied together.
 */

const GOOD = ['clarify-idea', 'superpowers:systematic-debugging', 'a.b_c', 'x', '9lives']
const BAD = ['/x', 'x y', '-x', '', ':x', 'x\ny', '.x']

test('the two copies of the name rule have the same source', () => {
  assert.equal(INVOKABLE_NAME.source, NAME.source)
  assert.equal(INVOKABLE_NAME.flags, NAME.flags)
})

test('the two copies accept the same names', () => {
  for (const name of GOOD) {
    assert.equal(NAME.test(name), true, name)
    assert.equal(INVOKABLE_NAME.test(name), true, name)
  }
})

test('the two copies refuse the same names', () => {
  for (const name of BAD) {
    assert.equal(NAME.test(name), false, JSON.stringify(name))
    assert.equal(INVOKABLE_NAME.test(name), false, JSON.stringify(name))
  }
})
