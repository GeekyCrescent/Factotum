import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SkillsView } from '../skills/arrange.ts'
import type { UsageCount } from '../types.ts'
import { neverUsed, unsortedOf, usedRows, whoLine } from './usage-view.ts'

const count = (name: string, owner = 0, agent = 0): UsageCount => ({ name, owner, agent, lastUsedAt: undefined })

const view: SkillsView = {
  list: { state: 'known', since: '2026-10-01T00:00:00.000Z' },
  notes: { state: 'ok', warnings: [] },
  groups: [
    { label: 'Ship', entries: [{ name: 'deploy', kind: 'command' }, { name: 'alpha', kind: 'skill' }] },
    { label: 'Docs', entries: [{ name: 'pdf', kind: 'skill' }] },
    { label: 'Unsorted', entries: [{ name: 'helper', kind: 'agent' }, { name: 'zeta', kind: 'skill' }] },
  ],
  stale: [],
}

test('used rows are the ones with a use, most first, ties by name', () => {
  const rows = usedRows([count('b', 1), count('a', 1), count('c', 0), count('d', 2, 2)])
  assert.deepEqual(rows.map((row) => row.name), ['d', 'a', 'b'])
})

test('never used keeps the list groups, drops the used and the empty groups, and leaves Unsorted out', () => {
  const groups = neverUsed(view, [count('deploy', 1), count('pdf', 0, 3), count('alpha')])
  assert.deepEqual(groups, [{ label: 'Ship', entries: [{ name: 'alpha', kind: 'skill' }] }])
})

test('with no counts everything the note groups is never used', () => {
  assert.deepEqual(neverUsed(view, []).map((group) => group.label), ['Ship', 'Docs'])
})

test('unsorted is its own list', () => {
  assert.deepEqual(unsortedOf(view).map((entry) => entry.name), ['helper', 'zeta'])
  assert.deepEqual(unsortedOf({ ...view, groups: [] }), [])
})

test('who line leaves out a side that is zero', () => {
  assert.equal(whoLine(count('x', 3, 1)), 'you 3 · agent 1')
  assert.equal(whoLine(count('x', 0, 2)), 'agent 2')
  assert.equal(whoLine(count('x', 4, 0)), 'you 4')
})
