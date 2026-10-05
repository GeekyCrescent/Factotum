import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SkillEntryView, SkillsView } from '../skills/arrange.ts'
import { applyInsertion, insertionFor, rowText, slashRows, slashTokenAt } from './slash.ts'

const skill = (name: string, extra: Partial<SkillEntryView> = {}): SkillEntryView => ({ name, kind: 'skill', ...extra })
const view = (...groups: readonly { label: string; entries: readonly SkillEntryView[] }[]): SkillsView => ({
  list: { state: 'known', since: '2026-10-03T00:00:00Z' },
  notes: { state: 'ok', warnings: [] },
  groups,
  stale: [],
})
const names = (rows: ReturnType<typeof slashRows>) => rows.map((row) => (row.kind === 'group' ? `#${row.label}` : row.entry.name))

// --- slashTokenAt (criterion 21) --------------------------------------------------------------

test('slashTokenAt: a slash at position 0 with the caret inside the first word is a token', () => {
  assert.deepEqual(slashTokenAt('/val', 4), { query: 'val', end: 4 })
  assert.deepEqual(slashTokenAt('/val rest', 2), { query: 'val', end: 4 })
  assert.deepEqual(slashTokenAt('/', 1), { query: '', end: 1 })
})

test('slashTokenAt: a slash anywhere else is no token', () => {
  assert.equal(slashTokenAt('src/app', 7), undefined)
  assert.equal(slashTokenAt('ver /etc', 8), undefined)
  assert.equal(slashTokenAt(' /val', 5), undefined)
  assert.equal(slashTokenAt('', 0), undefined)
})

test('slashTokenAt: the caret before the slash or past the first word is no token', () => {
  assert.equal(slashTokenAt('/val', 0), undefined)
  assert.equal(slashTokenAt('/val rest', 6), undefined)
  assert.equal(slashTokenAt('/val\nrest', 7), undefined)
  assert.deepEqual(slashTokenAt('/val rest', 4), { query: 'val', end: 4 })
})

// --- slashRows (criteria 22-23) ---------------------------------------------------------------

const full = view(
  { label: 'Pinned', entries: [skill('close-spec')] },
  { label: 'Specs', entries: [skill('create-spec'), skill('validate-spec')] },
  { label: 'Unsorted', entries: [skill('superpowers:systematic-debugging'), skill('revalidate'), skill('verify')] },
)

test('slashRows: an empty query keeps the groups, each header before its entries', () => {
  assert.deepEqual(names(slashRows(full, '')), [
    '#Pinned', 'close-spec', '#Specs', 'create-spec', 'validate-spec', '#Unsorted', 'superpowers:systematic-debugging', 'revalidate', 'verify',
  ])
})

test('slashRows: a query drops the groups and puts starts-with before contains', () => {
  assert.deepEqual(names(slashRows(full, 'val')), ['validate-spec', 'revalidate'])
})

test('slashRows: matches after the last colon too', () => {
  assert.deepEqual(names(slashRows(full, 'systematic')), ['superpowers:systematic-debugging'])
  assert.deepEqual(names(slashRows(full, 'super')), ['superpowers:systematic-debugging'])
})

test('slashRows: ties keep the view order, and case and NFC do not matter', () => {
  assert.deepEqual(names(slashRows(full, 'SPEC')), ['close-spec', 'create-spec', 'validate-spec'])
  const accented = view({ label: 'A', entries: [skill('café')] })
  assert.deepEqual(names(slashRows(accented, 'café')), ['café'])
})

test('slashRows: never searches why or when', () => {
  const noted = view({ label: 'A', entries: [skill('plan', { when: 'before a spec', why: 'spec work' })] })
  assert.deepEqual(slashRows(noted, 'spec'), [])
})

test('slashRows: no match, or no list, gives no rows', () => {
  assert.deepEqual(slashRows(full, 'zzz'), [])
  assert.deepEqual(slashRows({ ...full, groups: [] }, ''), [])
})

// --- rowText (criterion 22) -------------------------------------------------------------------

test('rowText: when, else why, else nothing', () => {
  assert.equal(rowText(skill('a', { when: 'W', why: 'Y' })), 'W')
  assert.equal(rowText(skill('a', { why: 'Y' })), 'Y')
  assert.equal(rowText(skill('a')), undefined)
})

// --- insertionFor and applyInsertion (criterion 24, 25; D8 table) -----------------------------

test('insertionFor: a skill or a command is `/name ` in both modes', () => {
  assert.deepEqual(insertionFor(skill('close-spec'), 'launch'), { kind: 'text', text: '/close-spec ' })
  assert.deepEqual(insertionFor({ name: 'compact', kind: 'command' }, 'reply'), { kind: 'text', text: '/compact ' })
})

test('insertionFor: an agent is the chip when launching and a sentence when replying', () => {
  const agent: SkillEntryView = { name: 'code-reviewer', kind: 'agent' }
  assert.deepEqual(insertionFor(agent, 'launch'), { kind: 'agent', name: 'code-reviewer' })
  assert.deepEqual(insertionFor(agent, 'reply'), { kind: 'text', text: 'Use the code-reviewer agent to ' })
})

test('applyInsertion: replaces the token, adds the space, caret behind it', () => {
  assert.deepEqual(applyInsertion('/val', 4, { kind: 'text', text: '/validate-spec ' }), { text: '/validate-spec ', caret: 15 })
})

test('applyInsertion: no second space when a blank already follows; the caret goes past it', () => {
  assert.deepEqual(applyInsertion('/val now', 4, { kind: 'text', text: '/validate-spec ' }), { text: '/validate-spec now', caret: 15 })
})

test('applyInsertion: the rest of the text after the token is kept', () => {
  assert.deepEqual(applyInsertion('/va x', 3, { kind: 'text', text: '/a ' }), { text: '/a x', caret: 3 })
})

test('applyInsertion: an agent in launch removes the token and leaves the rest', () => {
  assert.deepEqual(applyInsertion('/code fix it', 5, { kind: 'agent', name: 'code-reviewer' }), { text: 'fix it', caret: 0 })
  assert.deepEqual(applyInsertion('/code', 5, { kind: 'agent', name: 'code-reviewer' }), { text: '', caret: 0 })
})
