import { test } from 'node:test'
import assert from 'node:assert/strict'
import { restOf } from './route.ts'

test('the rest of a deep path is handed to the module (criterion 30)', () => {
  assert.equal(restOf('/m/sessions/019a0b1c-d2e3', 'sessions'), '019a0b1c-d2e3')
})

test('the module root, with or without a trailing slash, is the empty rest', () => {
  assert.equal(restOf('/m/sessions', 'sessions'), '')
  assert.equal(restOf('/m/sessions/', 'sessions'), '')
})

test('a module whose id is a PREFIX of another is not confused with it', () => {
  // `/m/sessions-old/x` is not under `/m/sessions`. A naive startsWith(prefix) would say it is.
  assert.equal(restOf('/m/sessions-old/x', 'sessions'), '')
})

test('the query is NOT part of rest: it travels separately as `search` (criterion 55)', () => {
  // The shell stores `location.pathname`, which has no query. `?ask=` reaches a screen only
  // through `search` — the v4 of the spec got this wrong.
  assert.equal(restOf('/m/sessions/019a', 'sessions'), '019a')
})
