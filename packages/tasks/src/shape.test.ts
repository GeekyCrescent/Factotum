import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_AREA_CHARS,
  MAX_LABEL_CHARS,
  MAX_LABELS,
  MAX_NOTES_CHARS,
  MAX_SUBTASK_CHARS,
  MAX_SUBTASKS,
  MAX_TITLE_CHARS,
  parseAccept,
  parseClose,
  parseLink,
  parseMove,
  parseNewTask,
  parsePatch,
  type Shaped,
} from './shape.ts'

function value<T>(shaped: Shaped<T>): T {
  if (!shaped.ok) throw new Error(`expected a value, got ${shaped.field}: ${shaped.reason}`)
  return shaped.value
}

function refusedField<T>(shaped: Shaped<T>): string {
  if (shaped.ok) throw new Error('expected a refusal, got a value')
  assert.ok(shaped.reason.length > 0, 'a refusal always says why')
  return shaped.field
}

const minimal = { title: 'Write the essay', status: 'todo' }

// --- each limit of criterion 10, just inside and just outside ------------------------------

const limits: readonly { readonly field: string; readonly inside: unknown; readonly outside: unknown }[] = [
  { field: 'title', inside: 'x'.repeat(MAX_TITLE_CHARS), outside: 'x'.repeat(MAX_TITLE_CHARS + 1) },
  { field: 'title', inside: 'x', outside: '' },
  { field: 'notes', inside: 'x'.repeat(MAX_NOTES_CHARS), outside: 'x'.repeat(MAX_NOTES_CHARS + 1) },
  { field: 'area', inside: 'x'.repeat(MAX_AREA_CHARS), outside: 'x'.repeat(MAX_AREA_CHARS + 1) },
  { field: 'area', inside: 'x', outside: '' },
  { field: 'priority', inside: 4, outside: 5 },
  { field: 'priority', inside: 0, outside: -1 },
  { field: 'priority', inside: 2, outside: 1.5 },
  { field: 'estimate', inside: 8, outside: 4 },
  { field: 'estimate', inside: 1, outside: 0 },
  { field: 'labels', inside: Array.from({ length: MAX_LABELS }, (_, i) => `l${i}`), outside: Array.from({ length: MAX_LABELS + 1 }, (_, i) => `l${i}`) },
  { field: 'labels.0', inside: ['x'.repeat(MAX_LABEL_CHARS)], outside: ['x'.repeat(MAX_LABEL_CHARS + 1)] },
  { field: 'labels.0', inside: ['x'], outside: [''] },
  { field: 'due', inside: '2026-10-16', outside: '2026-02-30' },
  { field: 'due', inside: '2028-02-29', outside: '16/10/2026' },
  { field: 'remindAt', inside: '2026-10-16T09:00:00+11:00', outside: '2026-10-16T09:00:00' },
  {
    field: 'subtasks',
    inside: Array.from({ length: MAX_SUBTASKS }, (_, i) => ({ text: `s${i}` })),
    outside: Array.from({ length: MAX_SUBTASKS + 1 }, (_, i) => ({ text: `s${i}` })),
  },
  { field: 'subtasks.0.text', inside: [{ text: 'x'.repeat(MAX_SUBTASK_CHARS) }], outside: [{ text: 'x'.repeat(MAX_SUBTASK_CHARS + 1) }] },
  { field: 'subtasks.0.text', inside: [{ text: 'x' }], outside: [{ text: '' }] },
  { field: 'project.siteId', inside: { host: null, siteId: 'factotum' }, outside: { host: null, siteId: '../etc' } },
  { field: 'project.host', inside: { host: 'omarchy', siteId: 'factotum' }, outside: { host: 'a/b', siteId: 'factotum' } },
]

for (const limit of limits) {
  const top = limit.field.split('.')[0] as string
  test(`${limit.field}: ${JSON.stringify(limit.inside).slice(0, 40)} passes, ${JSON.stringify(limit.outside).slice(0, 40)} is refused`, () => {
    value(parseNewTask({ ...minimal, [top]: limit.inside }))
    assert.equal(refusedField(parseNewTask({ ...minimal, [top]: limit.outside })), limit.field)
    // The same limits hold for an edit.
    value(parsePatch({ [top]: limit.inside }))
    assert.equal(refusedField(parsePatch({ [top]: limit.outside })), limit.field)
  })
}

// --- what a new card looks like ------------------------------------------------------------

test('a minimal card comes back with the title trimmed and nothing invented', () => {
  assert.deepEqual(value(parseNewTask({ title: '  Write the essay  ', status: 'backlog' })), { title: 'Write the essay', status: 'backlog' })
})

test('a title of only spaces is empty, and refused', () => {
  assert.equal(refusedField(parseNewTask({ title: '   ', status: 'todo' })), 'title')
})

test('the owner creates only in backlog or todo (criterion 9)', () => {
  for (const status of ['triage', 'in_progress', 'done', 'nope']) {
    assert.equal(refusedField(parseNewTask({ ...minimal, status })), 'status')
  }
})

test('a body that is not an object is refused on the whole body', () => {
  for (const raw of [null, 'title', 42, []]) assert.equal(refusedField(parseNewTask(raw)), 'body')
})

test('an unknown key is refused by name, never dropped in silence', () => {
  assert.equal(refusedField(parseNewTask({ ...minimal, colour: 'red' })), 'colour')
})

test('the reason never carries the value it refused', () => {
  const secret = 'x'.repeat(MAX_TITLE_CHARS) + 'SECRET'
  const shaped = parseNewTask({ ...minimal, title: secret })
  assert.equal(shaped.ok, false)
  if (!shaped.ok) assert.ok(!shaped.reason.includes('SECRET'))
})

test('nullable fields take null, and subtasks keep their id and done', () => {
  const card = value(
    parseNewTask({
      ...minimal,
      area: null,
      project: null,
      estimate: null,
      due: null,
      remindAt: null,
      subtasks: [{ id: 'a', text: 'one', done: true }, { text: 'two' }],
    }),
  )
  assert.equal(card.area, null)
  assert.deepEqual(card.subtasks, [{ id: 'a', text: 'one', done: true }, { text: 'two' }])
})

// --- a patch -------------------------------------------------------------------------------

test('an empty patch is valid and changes nothing', () => {
  assert.deepEqual(value(parsePatch({})), {})
})

test('a patch cannot carry the status: that is a move', () => {
  assert.equal(refusedField(parsePatch({ status: 'done' })), 'status')
})

// --- move, accept, close, link -------------------------------------------------------------

test('a move names a status and at most two neighbours', () => {
  assert.deepEqual(value(parseMove({ status: 'blocked', before: 'b' })), { status: 'blocked', before: 'b' })
  assert.deepEqual(value(parseMove({ status: 'done' })), { status: 'done' })
  assert.equal(refusedField(parseMove({ status: 'triage' })), 'status')
  assert.equal(refusedField(parseMove({ status: 'todo', before: '' })), 'before')
})

test('accept goes only to backlog or todo', () => {
  assert.equal(value(parseAccept({ to: 'todo' })), 'todo')
  assert.equal(value(parseAccept({ to: 'backlog' })), 'backlog')
  assert.equal(refusedField(parseAccept({ to: 'in_progress' })), 'to')
})

test('a close names a well-formed cycle and moves of next or backlog', () => {
  assert.deepEqual(value(parseClose({ from: '2026-W42', moves: { a: 'next', b: 'backlog' } })), {
    from: '2026-W42',
    moves: { a: 'next', b: 'backlog' },
  })
  assert.deepEqual(value(parseClose({ from: '2026-W09' })), { from: '2026-W09' })
  assert.equal(refusedField(parseClose({ from: '2026-W9' })), 'from')
  assert.equal(refusedField(parseClose({ from: '2026-W42', moves: { a: 'done' } })), 'moves.a')
})

test('a link takes a session id of the uuidv7 shape and a host or null', () => {
  const sessionId = '01920000-0000-7000-8000-000000000000'
  assert.deepEqual(value(parseLink({ host: null, sessionId })), { host: null, sessionId })
  assert.deepEqual(value(parseLink({ host: 'omarchy', sessionId })), { host: 'omarchy', sessionId })
  assert.equal(refusedField(parseLink({ host: null, sessionId: '../x' })), 'sessionId')
  assert.equal(refusedField(parseLink({ sessionId })), 'host')
})
