import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uuidv7 } from './id.ts'

test('it looks like a UUID, and says it is version 7', () => {
  const id = uuidv7()
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('SORTING BY ID IS SORTING BY TIME, which is the entire reason for v7', () => {
  // It is what lets `list` page the most recent sessions without an in-memory index.
  const early = uuidv7(Date.parse('2026-01-01T00:00:00.000Z'))
  const later = uuidv7(Date.parse('2026-09-15T00:00:00.000Z'))
  const latest = uuidv7(Date.parse('2027-01-01T00:00:00.000Z'))

  assert.deepEqual([latest, early, later].sort(), [early, later, latest])
})

test('two ids from the same millisecond still differ', () => {
  const now = Date.now()
  const ids = new Set(Array.from({ length: 500 }, () => uuidv7(now)))
  assert.equal(ids.size, 500)
})

test('the timestamp really is in the first six bytes', () => {
  const when = Date.parse('2026-09-15T12:34:56.789Z')
  const hex = uuidv7(when).replace(/-/g, '').slice(0, 12)
  assert.equal(Number.parseInt(hex, 16), when)
})

test('a nonsensical clock does not produce a malformed id', () => {
  assert.match(uuidv7(-1), /^[0-9a-f]{8}-[0-9a-f]{4}-7/)
  assert.match(uuidv7(0), /^0{8}-0{4}-7/)
})
