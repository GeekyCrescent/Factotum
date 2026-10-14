import { test } from 'node:test'
import assert from 'node:assert/strict'
import { insertAt, keyBetween, MAX_KEY_CHARS, renumber } from './order.ts'

function assertSorted(keys: readonly string[]): void {
  for (let i = 1; i < keys.length; i++) {
    assert.ok((keys[i - 1] as string) < (keys[i] as string), `${keys[i - 1]} < ${keys[i]} at ${i}`)
  }
}

test('a key between two neighbours sorts between them, as plain text', () => {
  const key = keyBetween('a', 'c')
  assert.ok('a' < key && key < 'c')
  const tight = keyBetween('a', 'a1')
  assert.ok('a' < tight && tight < 'a1')
})

test('a key at the start and at the end of a column', () => {
  const first = keyBetween('', 'V')
  assert.ok(first < 'V' && first.length > 0)
  const last = keyBetween('V', null)
  assert.ok(last > 'V')
  assert.ok(keyBetween('', null).length > 0)
})

test('a key never ends in 0, so there is always room in front of it', () => {
  for (const [a, b] of [['', '1'], ['0V', '1'], ['z', null]] as const) {
    assert.ok(!keyBetween(a, b).endsWith('0'))
  }
})

test('neighbours out of order are refused, never silently swapped', () => {
  assert.throws(() => keyBetween('c', 'a'))
  assert.throws(() => keyBetween('a', 'a'))
  assert.throws(() => keyBetween('a0', null))
  assert.throws(() => keyBetween('a!', null))
})

test('insertAt changes ONE key: the neighbours are kept as they were', () => {
  const keys = ['F', 'V', 'k']
  const after = insertAt(keys, 1)
  assert.equal(after.length, 4)
  assert.deepEqual([after[0], after[2], after[3]], keys)
  assertSorted(after)
})

test('insertAt at the start, at the end and into an empty column', () => {
  assertSorted(insertAt(['F', 'V'], 0))
  assertSorted(insertAt(['F', 'V'], 2))
  assert.equal(insertAt([], 0).length, 1)
  // An index past either end is clamped, not an error.
  assertSorted(insertAt(['F'], 99))
  assertSorted(insertAt(['F'], -3))
})

test('1 000 insertions into the same gap stay sorted and under the cap, renumbering when needed', () => {
  let keys: readonly string[] = ['F', 'V']
  let renumbered = 0
  for (let i = 0; i < 1000; i++) {
    const next = insertAt(keys, 1)
    if (next[0] !== keys[0]) renumbered++
    keys = next
    assert.ok(keys.every((key) => key.length <= MAX_KEY_CHARS))
  }
  assert.equal(keys.length, 1002)
  assertSorted(keys)
  assert.equal(new Set(keys).size, keys.length)
  assert.ok(renumbered > 0, 'the gap ran out at least once')
})

test('1 000 insertions at the end, the usual case, stay sorted', () => {
  let keys: readonly string[] = []
  for (let i = 0; i < 1000; i++) keys = insertAt(keys, keys.length)
  assertSorted(keys)
  assert.ok(keys.every((key) => key.length <= MAX_KEY_CHARS))
})

test('a column whose keys are broken is renumbered rather than refused', () => {
  const after = insertAt(['b', 'a'], 1)
  assert.equal(after.length, 3)
  assertSorted(after)
})

test('renumber gives n sorted keys of one short length', () => {
  const keys = renumber(5000)
  assert.equal(keys.length, 5000)
  assertSorted(keys)
  assert.ok(keys.every((key) => key.length <= 3 && !key.endsWith('0')))
  assert.deepEqual(renumber(0), [])
})
