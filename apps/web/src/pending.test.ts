import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alive, forModule, isPending, keyOf, nextExpiry, type Pending } from './pending.ts'

const NOW = Date.parse('2026-09-19T10:00:00.000Z')

function pending(moduleId: string, tag: string, until: string): Pending {
  return { key: keyOf(moduleId, tag), moduleId, tag, path: '/m/x', data: {}, until }
}

test('a pending whose deadline has passed is expired; one still ahead is alive (criterion 28)', () => {
  const past = pending('sessions', 'ask:a', '2026-09-19T09:59:59.000Z')
  const future = pending('sessions', 'ask:b', '2026-09-19T10:30:00.000Z')

  const split = alive([past, future], NOW)

  assert.deepEqual(split.alive, [future])
  assert.deepEqual(split.expired, [past])
})

test('exactly at the deadline it is expired, and an unreadable deadline is expired too', () => {
  const edge = pending('sessions', 'ask:a', new Date(NOW).toISOString())
  const garbage = pending('sessions', 'ask:b', 'not a date')
  assert.deepEqual(alive([edge, garbage], NOW).alive, [])
})

test('the most urgent last: alive ones come newest deadline first', () => {
  const soon = pending('sessions', 'ask:a', '2026-09-19T10:05:00.000Z')
  const later = pending('sessions', 'ask:b', '2026-09-19T10:50:00.000Z')
  assert.deepEqual(alive([soon, later], NOW).alive, [later, soon])
})

test('each module gets its own', () => {
  const a = pending('sessions', 'ask:a', '2026-09-19T10:30:00.000Z')
  const b = pending('other', 'x', '2026-09-19T10:30:00.000Z')
  assert.deepEqual(forModule([a, b], 'sessions'), [a])
})

test('a stored record is untrusted: the shape is checked, and the key must match its parts', () => {
  assert.equal(isPending(pending('sessions', 'ask:a', '2026-09-19T10:30:00.000Z')), true)
  assert.equal(isPending({ ...pending('sessions', 'ask:a', 'x'), key: 'other:key' }), false)
  assert.equal(isPending({ key: 'a:b', moduleId: 'a', tag: 'b' }), false)
  assert.equal(isPending(null), false)
})

test('the next expiry is the soonest deadline still ahead, and nothing when none is', () => {
  const soon = pending('sessions', 'ask:a', '2026-09-19T10:05:00.000Z')
  const later = pending('sessions', 'ask:b', '2026-09-19T10:50:00.000Z')
  const gone = pending('sessions', 'ask:c', '2026-09-19T09:00:00.000Z')

  assert.equal(nextExpiry([later, gone, soon], NOW), 5 * 60_000)
  assert.equal(nextExpiry([gone], NOW), undefined)
  assert.equal(nextExpiry([], NOW), undefined)
})
