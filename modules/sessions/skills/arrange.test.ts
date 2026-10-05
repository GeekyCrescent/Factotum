import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Announced } from '../types.ts'
import { arrange } from './arrange.ts'
import type { NotesRead, NoteRow } from './notes.ts'

const announced = (over: Partial<Announced> = {}): Announced => ({
  skills: ['alpha', 'bravo', 'code-review'],
  agents: ['code-reviewer', 'helper'],
  commands: ['clear', 'compact', 'deploy'],
  version: '2.1.0',
  since: '2026-10-03T00:00:00.000Z',
  ...over,
})

const row = (name: string, extra: Partial<NoteRow> = {}): NoteRow => ({ name, agent: false, why: undefined, when: undefined, ...extra })

const noted = (groups: readonly (readonly [string, readonly NoteRow[]])[], warnings: readonly string[] = []): NotesRead => ({
  state: 'ok',
  parsed: { groups: groups.map(([label, rows]) => ({ label, rows })), warnings },
})

const OFF: NotesRead = { state: 'off' }

test('without the list nothing is invented from the note: unknown, no groups', () => {
  const view = arrange({ announced: undefined, notes: noted([['G', [row('alpha')]]]), pinned: ['alpha'] })
  assert.deepEqual(view.list, { state: 'unknown' })
  assert.deepEqual(view.groups, [])
  assert.deepEqual(view.stale, [])
  assert.equal(view.notes.state, 'ok')
})

test('the list says when it was first seen and which version', () => {
  assert.deepEqual(arrange({ announced: announced(), notes: OFF, pinned: [] }).list, { state: 'known', since: '2026-10-03T00:00:00.000Z', version: '2.1.0' })
  assert.deepEqual(arrange({ announced: announced({ version: undefined }), notes: OFF, pinned: [] }).list, { state: 'known', since: '2026-10-03T00:00:00.000Z' })
})

test('criteria 17 and 18: with no note only skills and agents come out, in "Unsorted", bare, and never a command', () => {
  const view = arrange({ announced: announced(), notes: { state: 'missing' }, pinned: [] })
  assert.deepEqual(view.groups, [
    {
      label: 'Unsorted',
      entries: [
        { name: 'alpha', kind: 'skill' },
        { name: 'bravo', kind: 'skill' },
        { name: 'code-review', kind: 'skill' },
        { name: 'code-reviewer', kind: 'agent' },
        { name: 'helper', kind: 'agent' },
      ],
    },
  ])
  assert.deepEqual(view.notes, { state: 'missing', warnings: [] })
})

test('the note orders groups and entries, carries why and when, and a command appears only when the note names it', () => {
  const view = arrange({
    announced: announced(),
    notes: noted([
      ['Second in file, first shown', [row('deploy', { why: 'Ships', when: 'Friday' })]],
      ['Other', [row('bravo'), row('alpha', { why: 'A' })]],
    ]),
    pinned: [],
  })
  assert.deepEqual(view.groups.map((group) => group.label), ['Second in file, first shown', 'Other', 'Unsorted'])
  assert.deepEqual(view.groups[0]!.entries, [{ name: 'deploy', kind: 'command', why: 'Ships', when: 'Friday' }])
  assert.deepEqual(view.groups[1]!.entries, [{ name: 'bravo', kind: 'skill' }, { name: 'alpha', kind: 'skill', why: 'A' }])
  assert.deepEqual(view.groups[2]!.entries.map((entry) => entry.name), ['code-review', 'code-reviewer', 'helper'])
})

test('criterion 19: a name of the note the CLI does not announce is stale and does not come out', () => {
  const view = arrange({ announced: announced(), notes: noted([['G', [row('gone'), row('alpha'), row('ghost-agent', { agent: true })]]]), pinned: [] })
  assert.deepEqual(view.stale, ['gone', 'ghost-agent'])
  assert.deepEqual(view.groups[0]!.entries.map((entry) => entry.name), ['alpha'])
})

test('a row marked as agent looks only among agents; an unmarked one only among skills and commands', () => {
  const view = arrange({
    announced: announced({ skills: ['code-review'], agents: ['code-reviewer', 'code-review'] }),
    notes: noted([['G', [row('code-reviewer', { agent: true }), row('code-reviewer'), row('code-review')]]]),
    pinned: [],
  })
  assert.deepEqual(view.groups[0]!.entries, [{ name: 'code-reviewer', kind: 'agent' }, { name: 'code-review', kind: 'skill' }])
  assert.deepEqual(view.stale, ['code-reviewer'])
  // The agent that shares a name with the skill is left over: "Unsorted".
  assert.deepEqual(view.groups[1], { label: 'Unsorted', entries: [{ name: 'code-review', kind: 'agent' }] })
})

test('a name that is a skill and a command is a skill (D4 order)', () => {
  const view = arrange({ announced: announced({ skills: ['both'], commands: ['both'], agents: [] }), notes: noted([['G', [row('both')]]]), pinned: [] })
  assert.deepEqual(view.groups[0]!.entries, [{ name: 'both', kind: 'skill' }])
})

test('criterion 20: pins come first in the note order, the rest alphabetical, and leave their own group', () => {
  const view = arrange({
    announced: announced(),
    notes: noted([['One', [row('alpha', { why: 'A' }), row('bravo')]], ['Two', [row('code-review')]]]),
    pinned: ['zzz-not-announced', 'helper', 'code-review', 'alpha'],
  })
  assert.deepEqual(view.groups.map((group) => group.label), ['Pinned', 'One', 'Unsorted'])
  assert.deepEqual(view.groups[0]!.entries, [
    { name: 'alpha', kind: 'skill', why: 'A' },
    { name: 'code-review', kind: 'skill' },
    { name: 'helper', kind: 'agent' },
  ])
  assert.deepEqual(view.groups[1]!.entries, [{ name: 'bravo', kind: 'skill' }])
  assert.deepEqual(view.groups[2]!.entries.map((entry) => entry.name), ['code-reviewer'])
  assert.deepEqual(view.stale, [])
})

test('a pin that is an agent is found as an agent, and keeps the note row marked as agent', () => {
  const view = arrange({
    announced: announced(),
    notes: noted([['G', [row('helper', { agent: true, why: 'Helps' })]]]),
    pinned: ['helper'],
  })
  assert.deepEqual(view.groups.map((group) => group.label), ['Pinned', 'Unsorted'])
  assert.deepEqual(view.groups[0]!.entries, [{ name: 'helper', kind: 'agent', why: 'Helps' }])
  assert.equal(view.groups[1]!.entries.some((entry) => entry.name === 'helper'), false)
})

test('a pin the CLI no longer announces is neither shown nor stale', () => {
  const view = arrange({ announced: announced(), notes: noted([['G', [row('alpha')]]]), pinned: ['retired'] })
  assert.equal(view.groups.some((group) => group.label === 'Pinned'), false)
  assert.deepEqual(view.stale, [])
})

test('a pin repeated shows once, and a group left empty by pins is not emitted', () => {
  const view = arrange({ announced: announced(), notes: noted([['Only', [row('alpha')]]]), pinned: ['alpha', 'alpha'] })
  assert.deepEqual(view.groups.map((group) => group.label), ['Pinned', 'Unsorted'])
  assert.equal(view.groups[0]!.entries.length, 1)
})

test('the notes state passes through with its reason and its warnings', () => {
  assert.deepEqual(arrange({ announced: announced(), notes: { state: 'invalid', reason: 'skills.notes: no' }, pinned: [] }).notes, { state: 'invalid', reason: 'skills.notes: no', warnings: [] })
  assert.deepEqual(arrange({ announced: announced(), notes: noted([], ['dup']), pinned: [] }).notes, { state: 'ok', warnings: ['dup'] })
})
