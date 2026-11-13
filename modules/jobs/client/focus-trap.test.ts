import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trappedFocus } from './focus-trap.ts'

test('Tab inside a sheet goes round its own controls, never out to the review behind', () => {
  assert.equal(trappedFocus(0, 3, false), null, 'the middle of the sheet: the browser moves it')
  assert.equal(trappedFocus(2, 3, false), 0, 'Tab on the last goes to the first')
  assert.equal(trappedFocus(0, 3, true), 2, 'Shift+Tab on the first goes to the last')
  assert.equal(trappedFocus(1, 3, true), null)
})

test('focus outside the sheet (or on its title) is brought into it', () => {
  assert.equal(trappedFocus(-1, 3, false), 0)
  assert.equal(trappedFocus(-1, 3, true), 2)
})

test('a sheet with nothing to focus keeps the focus where it is', () => {
  assert.equal(trappedFocus(-1, 0, false), null)
})
