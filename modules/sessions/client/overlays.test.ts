import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DECISION_OVERLAYS, mayOpenItself } from './overlays.ts'

test('the decision overlays are the ask and the questions, and NOT the drawer', () => {
  assert.deepEqual([...DECISION_OVERLAYS].sort(), ['ask', 'questions'])
  assert.equal(DECISION_OVERLAYS.has('drawer'), false)
})

test('with nothing open, or the drawer open, an area that arrives opens itself, as an ask does today', () => {
  assert.equal(mayOpenItself(undefined, false), true)
  assert.equal(mayOpenItself('drawer', false), true)
})

test('with a decision open, the area that arrives stays a notice (criterion 38)', () => {
  assert.equal(mayOpenItself('ask', false), false)
  assert.equal(mayOpenItself('questions', false), false)
})

test('once decided, never again: nothing opens itself over what the owner already closed', () => {
  assert.equal(mayOpenItself(undefined, true), false)
  assert.equal(mayOpenItself('drawer', true), false)
})
