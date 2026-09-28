import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModuleSummary } from './api.ts'
import { landing, ordered } from './nav.ts'

const on = (id: string, order?: number): ModuleSummary =>
  order === undefined ? { id, status: { kind: 'enabled' } } : { id, nav: { label: id, icon: 'dot', order }, status: { kind: 'enabled' } }
const off = (id: string, order: number): ModuleSummary => ({ id, nav: { label: id, icon: 'dot', order }, status: { kind: 'disabled', reason: 'x' } })

test('modules come in nav.order; without one they go last, and a tie falls back to the id', () => {
  const list = [on('c'), on('b', 20), on('a', 20), on('d', 10)]
  assert.deepEqual(ordered(list).map((m) => m.id), ['d', 'a', 'b', 'c'])
})

test('ordering does not touch the list it is given', () => {
  const list = [on('b', 2), on('a', 1)]
  ordered(list)
  assert.deepEqual(list.map((m) => m.id), ['b', 'a'])
})

test('"/" lands on the first ENABLED module by nav.order, and on nothing when none is enabled', () => {
  assert.equal(landing([off('a', 1), on('b', 5), on('c', 2)])?.id, 'c')
  assert.equal(landing([off('a', 1)]), undefined)
  assert.equal(landing([]), undefined)
})
