import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Task } from '../types.ts'
import {
  closeMoves,
  columnsOf,
  draftOf,
  messageOf,
  patchOf,
  statusOf,
  cycleTitle,
  dropAt,
  isOverdue,
  labelsFrom,
  localInputOf,
  matches,
  neighbours,
  parseFilter,
  progressOf,
  projectKey,
  reminderFrom,
  serializeFilter,
  todayIn,
} from './model.ts'

function card(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    notes: '',
    status: 'todo',
    order: 'V',
    cycle: '2026-W42',
    area: null,
    project: null,
    priority: 0,
    labels: [],
    estimate: null,
    due: null,
    remindAt: null,
    remindedAt: null,
    reminderMissed: false,
    subtasks: [],
    source: { kind: 'owner' },
    sessions: [],
    createdAt: 'a',
    updatedAt: 'a',
    completedAt: null,
    ...over,
  }
}

// --- grouping and order ---------------------------------------------------------------------

test('cards are grouped in the six columns, each in the order of its keys as plain text', () => {
  const columns = columnsOf([
    card('b', { order: 'b' }),
    card('A', { order: 'A' }),
    card('z', { status: 'done' }),
    card('t', { status: 'triage' }),
    card('x', { status: 'backlog', cycle: null }),
  ])
  // 'A' < 'b' as text; localeCompare would put them the other way round.
  assert.deepEqual(columns.todo.map((t) => t.id), ['A', 'b'])
  assert.deepEqual(columns.done.map((t) => t.id), ['z'])
  assert.deepEqual(columns.backlog.map((t) => t.id), ['x'])
  assert.deepEqual(Object.keys(columns), ['backlog', 'todo', 'in_progress', 'blocked', 'done', 'canceled'])
})

// --- filters (criterion 13) -----------------------------------------------------------------

test('a filter by area, label or project keeps only those cards; an empty one keeps all', () => {
  const a = card('a', { area: 'BWR', labels: ['x'], project: { host: null, siteId: 'factotum' } })
  const b = card('b', { area: '8780', labels: ['y'], project: { host: 'mac', siteId: 'notes' } })
  assert.equal(matches(a, {}), true)
  assert.deepEqual([a, b].filter((t) => matches(t, { area: 'BWR' })).map((t) => t.id), ['a'])
  assert.deepEqual([a, b].filter((t) => matches(t, { label: 'y' })).map((t) => t.id), ['b'])
  assert.deepEqual([a, b].filter((t) => matches(t, { project: projectKey({ host: 'mac', siteId: 'notes' }) })).map((t) => t.id), ['b'])
  assert.deepEqual([a, b].filter((t) => matches(t, { area: 'BWR', label: 'y' })).map((t) => t.id), [])
})

test('the filter survives a round trip through storage, and junk reads as no filter', () => {
  const filter = { area: 'BWR', project: '/factotum' }
  assert.deepEqual(parseFilter(serializeFilter(filter)), filter)
  for (const junk of [null, '', 'not json', '[1]', '{"area": 3}', '{"colour": "red"}']) assert.deepEqual(parseFilter(junk), {}, String(junk))
  assert.deepEqual(parseFilter('{"area": "BWR", "label": 7}'), { area: 'BWR' })
})

// --- what a card shows ----------------------------------------------------------------------

test('a past due date on an unfinished card is overdue; today is not, and done never is (criterion 11)', () => {
  const today = '2026-10-14'
  assert.equal(isOverdue(card('a', { due: '2026-10-13' }), today), true)
  assert.equal(isOverdue(card('a', { due: '2026-10-14' }), today), false)
  assert.equal(isOverdue(card('a', { due: null }), today), false)
  assert.equal(isOverdue(card('a', { due: '2026-10-01', status: 'done' }), today), false)
  assert.equal(isOverdue(card('a', { due: '2026-10-01', status: 'canceled' }), today), false)
})

test('subtasks show as done/total, and nothing without subtasks (criterion 12)', () => {
  const subtasks = [true, false, true, false, true].map((done, i) => ({ id: `s${i}`, text: 't', done }))
  assert.equal(progressOf(card('a', { subtasks })), '3/5')
  assert.equal(progressOf(card('a')), undefined)
})

test('today is the calendar day in the board’s zone', () => {
  assert.equal(todayIn('Australia/Sydney', new Date('2026-10-13T14:00:00Z')), '2026-10-14')
  assert.equal(todayIn('UTC', new Date('2026-10-13T14:00:00Z')), '2026-10-13')
})

test('the cycle header: week and days, with the month once or twice', () => {
  assert.equal(cycleTitle('2026-W42', { start: '2026-10-12', end: '2026-10-18' }), 'W42 · 12–18 Oct')
  assert.equal(cycleTitle('2026-W44', { start: '2026-10-26', end: '2026-11-01' }), 'W44 · 26 Oct – 1 Nov')
  assert.equal(cycleTitle('2026-W09', { start: '2026-02-23', end: '2026-03-01' }), 'W09 · 23 Feb – 1 Mar')
})

test('labels typed with commas: trimmed, once each, nothing empty', () => {
  assert.deepEqual(labelsFrom(' uni,  bwr ,,uni, '), ['uni', 'bwr'])
  assert.deepEqual(labelsFrom(''), [])
})

test('a reminder picked on the device keeps its offset, and reads back the same', () => {
  const iso = reminderFrom('2026-10-16T09:00')
  assert.ok(iso !== null)
  assert.match(iso ?? '', /^2026-10-16T09:00:00[+-]\d{2}:\d{2}$/)
  assert.equal(new Date(iso ?? '').getTime(), new Date(2026, 9, 16, 9, 0).getTime())
  assert.equal(localInputOf(iso), '2026-10-16T09:00')
  assert.equal(reminderFrom(''), null)
  assert.equal(reminderFrom('nonsense'), null)
  assert.equal(localInputOf(null), '')
})

// --- where a drag lands, in two axes (design D11) -------------------------------------------

const columnsBoxes = [
  { status: 'backlog' as const, left: 0, right: 100 },
  { status: 'todo' as const, left: 110, right: 210 },
]
const cards = [
  { id: 'a', status: 'todo' as const, top: 0, bottom: 40 },
  { id: 'b', status: 'todo' as const, top: 50, bottom: 90 },
  { id: 'c', status: 'todo' as const, top: 100, bottom: 140 },
]

test('the column comes from x, the index from y among the OTHER cards', () => {
  assert.deepEqual(dropAt(columnsBoxes, cards, 150, 10, 'x'), { status: 'todo', index: 0 })
  assert.deepEqual(dropAt(columnsBoxes, cards, 150, 75, 'x'), { status: 'todo', index: 2 })
  assert.deepEqual(dropAt(columnsBoxes, cards, 150, 500, 'x'), { status: 'todo', index: 3 })
  assert.deepEqual(dropAt(columnsBoxes, cards, 50, 10, 'x'), { status: 'backlog', index: 0 })
  // Dragging `a` itself: it is not counted where it was.
  assert.deepEqual(dropAt(columnsBoxes, cards, 150, 75, 'a'), { status: 'todo', index: 1 })
})

test('between two columns, the nearest one; with no columns, nowhere', () => {
  assert.equal(dropAt(columnsBoxes, cards, 104, 0, 'x')?.status, 'backlog')
  assert.equal(dropAt(columnsBoxes, cards, 108, 0, 'x')?.status, 'todo')
  assert.equal(dropAt(columnsBoxes, cards, 900, 0, 'x')?.status, 'todo')
  assert.equal(dropAt([], cards, 0, 0, 'x'), undefined)
})

test('neighbours: in front of the card at the index, or after the last one, or none', () => {
  assert.deepEqual(neighbours(['a', 'b'], 0), { before: 'a' })
  assert.deepEqual(neighbours(['a', 'b'], 1), { before: 'b' })
  assert.deepEqual(neighbours(['a', 'b'], 2), { after: 'b' })
  assert.deepEqual(neighbours([], 0), {})
})

// --- closing a cycle --------------------------------------------------------------------------

test('the close sends every unfinished card, next by default (criterion 15)', () => {
  assert.deepEqual(closeMoves(['a', 'b', 'c'], new Set(['b'])), { a: 'next', b: 'backlog', c: 'next' })
})

// --- the sheet: a draft of the card and the patch of what changed (criterion 10) -------------

test('an untouched draft patches nothing', () => {
  const task = card('a', { area: 'BWR', labels: ['x'], due: '2026-10-20', estimate: 3, priority: 2 })
  assert.deepEqual(patchOf(task, draftOf(task)), {})
})

test('a draft patches only what changed, with empty fields as null', () => {
  const task = card('a', { area: 'BWR', labels: ['x'], due: '2026-10-20' })
  const draft = { ...draftOf(task), title: 'New', area: '', labels: 'x, y', due: '', estimate: '5', priority: '1' }
  assert.deepEqual(patchOf(task, draft), { title: 'New', area: null, labels: ['x', 'y'], due: null, estimate: 5, priority: 1 })
})

test('the project of a draft: a known key, other with a site, or none', () => {
  const task = card('a')
  assert.deepEqual(patchOf(task, { ...draftOf(task), project: 'omarchy/factotum' }), { project: { host: 'omarchy', siteId: 'factotum' } })
  assert.deepEqual(patchOf(task, { ...draftOf(task), project: '/factotum' }), { project: { host: null, siteId: 'factotum' } })
  const linked = card('b', { project: { host: null, siteId: 'factotum' } })
  assert.equal(draftOf(linked).project, '/factotum')
  assert.deepEqual(patchOf(linked, { ...draftOf(linked), project: '' }), { project: null })
})

test('a reminder in the draft becomes the stored instant, and clearing it is null', () => {
  const task = card('a', { remindAt: reminderFrom('2026-10-16T09:00') })
  assert.deepEqual(patchOf(task, draftOf(task)), {})
  assert.deepEqual(patchOf(task, { ...draftOf(task), remind: '' }), { remindAt: null })
})

test('a failed request reads as its status and message, whatever was thrown', () => {
  const error = Object.assign(new Error('title: Too big'), { status: 400 })
  assert.equal(statusOf(error), 400)
  assert.equal(messageOf(error), 'title: Too big')
  assert.equal(statusOf('nope'), undefined)
  assert.equal(messageOf('nope'), 'nope')
})
