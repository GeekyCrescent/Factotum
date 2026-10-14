import { test } from 'node:test'
import assert from 'node:assert/strict'
import { board, ctx, task } from '../test-support.ts'
import type { Board, Result, Task } from '../types.ts'
import { acceptTask, closeCycles, createTask, emptyBoard, linkSession, moveTask, patchTask, removeTask } from './ops.ts'

function ok<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.reason}`)
  return result.value
}

function code<T>(result: Result<T>): string {
  if (result.ok) throw new Error('expected an error')
  return result.error.code
}

function find(b: Board, id: string): Task {
  const found = b.tasks.find((t) => t.id === id)
  if (found === undefined) throw new Error(`no card ${id}`)
  return found
}

function column(b: Board, status: Task['status']): readonly string[] {
  return b.tasks
    .filter((t) => t.status === status)
    .sort((x, y) => (x.order < y.order ? -1 : x.order > y.order ? 1 : 0))
    .map((t) => t.id)
}

const NOW_ISO = '2026-10-13T23:00:00.000Z'

// --- an empty board -------------------------------------------------------------------------

test('an empty board opens the cycle of now in its zone', () => {
  assert.deepEqual(emptyBoard('Australia/Sydney', new Date('2026-10-11T13:00:00Z')), {
    version: 1,
    timeZone: 'Australia/Sydney',
    openCycle: '2026-W42',
    tasks: [],
    cycles: [],
    agentCounts: {},
    next: null,
  })
})

// --- create ---------------------------------------------------------------------------------

test('create in backlog: no cycle, owner source, timestamps of now, at the end of the column', () => {
  const start = board([task({ id: 'a', order: 'F' })])
  const { board: after, task: card } = ok(createTask(start, { title: 'Essay', status: 'backlog' }, ctx()))
  assert.equal(card.id, 'n1')
  assert.equal(card.cycle, null)
  assert.deepEqual(card.source, { kind: 'owner' })
  assert.equal(card.createdAt, NOW_ISO)
  assert.equal(card.updatedAt, NOW_ISO)
  assert.deepEqual(column(after, 'backlog'), ['a', 'n1'])
})

test('create in todo puts the card in the OPEN cycle, even while a close is pending (criterion 8)', () => {
  const pending = board([], { openCycle: '2026-W41' })
  const { task: card } = ok(createTask(pending, { title: 'x', status: 'todo' }, ctx()))
  assert.equal(card.cycle, '2026-W41')
})

test('create fills subtask ids and done, and keeps every field it was given', () => {
  const { task: card } = ok(
    createTask(
      board(),
      {
        title: 'x',
        status: 'todo',
        notes: 'n',
        area: '8780',
        project: { host: null, siteId: 'factotum' },
        priority: 1,
        labels: ['uni'],
        estimate: 3,
        due: '2026-10-16',
        remindAt: '2026-10-16T09:00:00+11:00',
        subtasks: [{ text: 'one' }, { id: 'keep', text: 'two', done: true }],
      },
      ctx(),
    ),
  )
  assert.deepEqual(card.subtasks, [
    { id: 'n2', text: 'one', done: false },
    { id: 'keep', text: 'two', done: true },
  ])
  assert.equal(card.area, '8780')
  assert.deepEqual(card.project, { host: null, siteId: 'factotum' })
  assert.equal(card.estimate, 3)
  assert.equal(card.remindAt, '2026-10-16T09:00:00+11:00')
})

test('create never touches the board it was given', () => {
  const start = board([task({ id: 'a' })])
  const frozen = structuredClone(start)
  createTask(start, { title: 'x', status: 'backlog' }, ctx())
  assert.deepEqual(start, frozen)
})

// --- patch ----------------------------------------------------------------------------------

test('patch changes only what it names, and stamps updatedAt', () => {
  const start = board([task({ id: 'a', title: 'old', area: 'BWR' })])
  const { task: card } = ok(patchTask(start, 'a', { title: 'new' }, ctx()))
  assert.equal(card.title, 'new')
  assert.equal(card.area, 'BWR')
  assert.equal(card.updatedAt, NOW_ISO)
})

test('patch can clear a field with null', () => {
  const start = board([task({ id: 'a', area: 'BWR', due: '2026-10-20' })])
  const { task: card } = ok(patchTask(start, 'a', { area: null, due: null }, ctx()))
  assert.equal(card.area, null)
  assert.equal(card.due, null)
})

test('a new reminder time forgets that the old one was sent or missed', () => {
  const start = board([task({ id: 'a', remindAt: '2026-10-10T09:00:00+11:00', remindedAt: '2026-10-10T09:00:30+11:00', reminderMissed: true })])
  const { task: card } = ok(patchTask(start, 'a', { remindAt: '2026-10-20T09:00:00+11:00' }, ctx()))
  assert.equal(card.remindedAt, null)
  assert.equal(card.reminderMissed, false)
})

test('the same reminder time sent again keeps what happened to it', () => {
  const start = board([task({ id: 'a', remindAt: '2026-10-10T09:00:00+11:00', remindedAt: '2026-10-10T09:00:30+11:00' })])
  const { task: card } = ok(patchTask(start, 'a', { remindAt: '2026-10-10T09:00:00+11:00', title: 'x' }, ctx()))
  assert.equal(card.remindedAt, '2026-10-10T09:00:30+11:00')
})

test('subtasks: an id is kept, a missing or repeated one is made new', () => {
  const start = board([task({ id: 'a', subtasks: [{ id: 's1', text: 'one', done: false }] })])
  const { task: card } = ok(
    patchTask(start, 'a', { subtasks: [{ id: 's1', text: 'one', done: true }, { id: 's1', text: 'dup' }, { text: 'new' }] }, ctx()),
  )
  assert.deepEqual(card.subtasks, [
    { id: 's1', text: 'one', done: true },
    { id: 'n1', text: 'dup', done: false },
    { id: 'n2', text: 'new', done: false },
  ])
})

test('a reminder set on a done or canceled card is dropped: it would remind of finished work (criterion 37)', () => {
  for (const status of ['done', 'canceled'] as const) {
    const start = board([task({ id: 'a', status, cycle: '2026-W42' })])
    assert.equal(ok(patchTask(start, 'a', { remindAt: '2026-10-20T09:00:00+11:00' }, ctx())).task.remindAt, null, status)
  }
})

test('patch of a card that is not on the board is not-found', () => {
  assert.equal(code(patchTask(board(), 'nope', { title: 'x' }, ctx())), 'not-found')
})

// --- move: the rules of D2 ------------------------------------------------------------------

test('backlog → todo enters the open cycle; back to backlog leaves it (criterion 8)', () => {
  const start = board([task({ id: 'a' })])
  const inTodo = ok(moveTask(start, 'a', { status: 'todo' }, ctx()))
  assert.equal(find(inTodo.board, 'a').cycle, '2026-W42')
  const back = ok(moveTask(inTodo.board, 'a', { status: 'backlog' }, ctx()))
  assert.equal(find(back.board, 'a').cycle, null)
})

test('from backlog to in progress or blocked also enters the OPEN cycle, not the current one', () => {
  const pending = board([task({ id: 'a' }), task({ id: 'b' })], { openCycle: '2026-W41' })
  assert.equal(ok(moveTask(pending, 'a', { status: 'in_progress' }, ctx())).task.cycle, '2026-W41')
  assert.equal(ok(moveTask(pending, 'b', { status: 'blocked' }, ctx())).task.cycle, '2026-W41')
})

test('done sets completedAt; leaving done clears it (criterion 8)', () => {
  const start = board([task({ id: 'a', status: 'todo', cycle: '2026-W42' })])
  const done = ok(moveTask(start, 'a', { status: 'done' }, ctx()))
  assert.equal(done.task.completedAt, NOW_ISO)
  assert.equal(done.task.cycle, '2026-W42')
  const reopened = ok(moveTask(done.board, 'a', { status: 'in_progress' }, ctx()))
  assert.equal(reopened.task.completedAt, null)
})

test('reordering inside done keeps the first completedAt', () => {
  const start = board([task({ id: 'a', status: 'done', cycle: '2026-W42', completedAt: '2026-10-12T00:00:00.000Z', order: 'V' })])
  assert.equal(ok(moveTask(start, 'a', { status: 'done' }, ctx())).task.completedAt, '2026-10-12T00:00:00.000Z')
})

test('done and canceled drop a reminder not yet sent (criterion 37)', () => {
  for (const status of ['done', 'canceled'] as const) {
    const start = board([task({ id: 'a', status: 'todo', cycle: '2026-W42', remindAt: '2026-10-20T09:00:00+11:00' })])
    assert.equal(ok(moveTask(start, 'a', { status }, ctx())).task.remindAt, null, status)
  }
})

test('done keeps a reminder that was already sent: it is history', () => {
  const start = board([
    task({ id: 'a', status: 'todo', cycle: '2026-W42', remindAt: '2026-10-10T09:00:00+11:00', remindedAt: '2026-10-10T09:00:20+11:00' }),
  ])
  assert.equal(ok(moveTask(start, 'a', { status: 'done' }, ctx())).task.remindAt, '2026-10-10T09:00:00+11:00')
})

test('move lands before or after a neighbour, or at the end, writing ONE key', () => {
  const start = board([
    task({ id: 'a', status: 'todo', cycle: '2026-W42', order: 'F' }),
    task({ id: 'b', status: 'todo', cycle: '2026-W42', order: 'V' }),
    task({ id: 'x' }),
  ])
  const before = ok(moveTask(start, 'x', { status: 'todo', before: 'b' }, ctx())).board
  assert.deepEqual(column(before, 'todo'), ['a', 'x', 'b'])
  assert.equal(find(before, 'a').order, 'F')
  assert.equal(find(before, 'b').order, 'V')
  const after = ok(moveTask(start, 'x', { status: 'todo', after: 'b' }, ctx())).board
  assert.deepEqual(column(after, 'todo'), ['a', 'b', 'x'])
  const first = ok(moveTask(start, 'x', { status: 'todo', before: 'a' }, ctx())).board
  assert.deepEqual(column(first, 'todo'), ['x', 'a', 'b'])
  const end = ok(moveTask(start, 'x', { status: 'todo' }, ctx())).board
  assert.deepEqual(column(end, 'todo'), ['a', 'b', 'x'])
})

test('reorder inside one column is a move to the same status', () => {
  const start = board([
    task({ id: 'a', order: 'F' }),
    task({ id: 'b', order: 'V' }),
    task({ id: 'c', order: 'k' }),
  ])
  const after = ok(moveTask(start, 'c', { status: 'backlog', before: 'a' }, ctx())).board
  assert.deepEqual(column(after, 'backlog'), ['c', 'a', 'b'])
})

test('a neighbour that is not in that column is refused by name', () => {
  const start = board([task({ id: 'a' }), task({ id: 'b', status: 'todo', cycle: '2026-W42' })])
  const result = moveTask(start, 'a', { status: 'todo', before: 'zzz' }, ctx())
  assert.equal(code(result), 'invalid')
  if (!result.ok && result.error.code === 'invalid') assert.equal(result.error.field, 'before')
})

test('a card dropped next to itself stays where it is', () => {
  const start = board([
    task({ id: 'a', status: 'todo', cycle: '2026-W42', order: 'F' }),
    task({ id: 'b', status: 'todo', cycle: '2026-W42', order: 'V' }),
  ])
  for (const to of [{ before: 'b' }, { after: 'b' }] as const) {
    const after = ok(moveTask(start, 'b', { status: 'todo', ...to }, ctx())).board
    assert.deepEqual(column(after, 'todo'), ['a', 'b'])
    assert.equal(find(after, 'b').order, 'V')
  }
})

test('a card in triage does not move: it is accepted', () => {
  const start = board([task({ id: 'a', status: 'triage' })])
  assert.equal(code(moveTask(start, 'a', { status: 'todo' }, ctx())), 'conflict')
})

test('a full column whose gap is spent is renumbered in the same change', () => {
  // Two keys with no single-character room between them and a long tail: the next key passes 64.
  const tight = 'V' + '0'.repeat(63) + '1'
  const start = board([
    task({ id: 'a', order: 'V' }),
    task({ id: 'b', order: tight }),
    task({ id: 'x', status: 'todo', cycle: '2026-W42' }),
  ])
  const after = ok(moveTask(start, 'x', { status: 'backlog', before: 'b' }, ctx())).board
  assert.deepEqual(column(after, 'backlog'), ['a', 'x', 'b'])
  assert.ok(after.tasks.every((t) => t.order.length <= 64))
})

// --- accept ---------------------------------------------------------------------------------

test('accept from triage to backlog or todo (D2)', () => {
  const start = board([task({ id: 'a', status: 'triage' }), task({ id: 'b', status: 'triage' })])
  const toBacklog = ok(acceptTask(start, 'a', 'backlog', ctx()))
  assert.equal(toBacklog.task.status, 'backlog')
  assert.equal(toBacklog.task.cycle, null)
  const toTodo = ok(acceptTask(start, 'b', 'todo', ctx()))
  assert.equal(toTodo.task.status, 'todo')
  assert.equal(toTodo.task.cycle, '2026-W42')
})

test('accepting a card that is not in triage is a conflict', () => {
  assert.equal(code(acceptTask(board([task({ id: 'a' })]), 'a', 'todo', ctx())), 'conflict')
  assert.equal(code(acceptTask(board(), 'nope', 'todo', ctx())), 'not-found')
})

// --- remove ---------------------------------------------------------------------------------

test('remove takes the card off the board', () => {
  const after = ok(removeTask(board([task({ id: 'a' }), task({ id: 'b' })]), 'a'))
  assert.deepEqual(
    after.board.tasks.map((t) => t.id),
    ['b'],
  )
  assert.equal(code(removeTask(board(), 'a')), 'not-found')
})

// --- linkSession ----------------------------------------------------------------------------

test('a linked session moves the card to in progress, in the open cycle, in one change (criterion 31)', () => {
  const start = board([task({ id: 'a' })])
  const { task: card } = ok(linkSession(start, 'a', { host: null, sessionId: 's1' }, ctx()))
  assert.equal(card.status, 'in_progress')
  assert.equal(card.cycle, '2026-W42')
  assert.deepEqual(card.sessions, [{ host: null, sessionId: 's1', at: NOW_ISO }])
})

test('linking the same session twice keeps one link; a done card reopens', () => {
  const start = board([task({ id: 'a', status: 'done', cycle: '2026-W42', completedAt: NOW_ISO, sessions: [{ host: 'mac', sessionId: 's1', at: NOW_ISO }] })])
  const { task: card } = ok(linkSession(start, 'a', { host: 'mac', sessionId: 's1' }, ctx()))
  assert.equal(card.sessions.length, 1)
  assert.equal(card.status, 'in_progress')
  assert.equal(card.completedAt, null)
})

test('a card in triage is accepted before it is linked', () => {
  assert.equal(code(linkSession(board([task({ id: 'a', status: 'triage' })]), 'a', { host: null, sessionId: 's' }, ctx())), 'conflict')
})

// --- closeCycles (criteria 16 and 17) -------------------------------------------------------

function cycleBoard(): Board {
  return board(
    [
      task({ id: 'todo', status: 'todo', cycle: '2026-W39', order: 'F' }),
      task({ id: 'doing', status: 'in_progress', cycle: '2026-W39' }),
      task({ id: 'stuck', status: 'blocked', cycle: '2026-W39' }),
      task({ id: 'done', status: 'done', cycle: '2026-W39', completedAt: NOW_ISO }),
      task({ id: 'gone', status: 'canceled', cycle: '2026-W39' }),
      task({ id: 'back', status: 'backlog', order: 'F' }),
      task({ id: 'tri', status: 'triage' }),
    ],
    { openCycle: '2026-W39' },
  )
}

test('three skipped cycles close in one step towards the current one, and no unfinished card is lost', () => {
  const result = ok(closeCycles(cycleBoard(), { from: '2026-W39' }, ctx()))
  const after = result.board
  assert.deepEqual(
    result.closed.map((c) => c.id),
    ['2026-W39', '2026-W40', '2026-W41'],
  )
  assert.equal(after.openCycle, '2026-W42')
  // By default everything unfinished goes on, with its status.
  for (const [id, status] of [['todo', 'todo'], ['doing', 'in_progress'], ['stuck', 'blocked']] as const) {
    const card = find(after, id)
    assert.equal(card.cycle, '2026-W42', id)
    assert.equal(card.status, status, id)
  }
  // Backlog and triage are untouched.
  assert.equal(find(after, 'back').cycle, null)
  assert.equal(find(after, 'tri').status, 'triage')
  assert.equal(after.tasks.length, 5)
})

test('done and canceled leave the board and are archived as copies in the first closed cycle', () => {
  const { board: after, closed } = ok(closeCycles(cycleBoard(), { from: '2026-W39' }, ctx()))
  const first = closed[0]
  assert.ok(first !== undefined)
  assert.deepEqual(
    first.done.map((t) => t.id),
    ['done'],
  )
  assert.deepEqual(
    first.canceled.map((t) => t.id),
    ['gone'],
  )
  assert.deepEqual([...first.carried].sort(), ['doing', 'stuck', 'todo'])
  assert.equal(first.closedAt, NOW_ISO)
  assert.equal(closed[1]?.done.length, 0)
  assert.equal(closed[1]?.carried.length, 0)
  assert.ok(!after.tasks.some((t) => t.id === 'done' || t.id === 'gone'))
  assert.deepEqual(after.cycles, closed)
})

test('a card sent back goes to the end of the backlog without a cycle', () => {
  const { board: after, closed } = ok(closeCycles(cycleBoard(), { from: '2026-W39', moves: { todo: 'backlog', doing: 'next' } }, ctx()))
  const card = find(after, 'todo')
  assert.equal(card.status, 'backlog')
  assert.equal(card.cycle, null)
  assert.deepEqual(column(after, 'backlog'), ['back', 'todo'])
  assert.ok(!closed[0]?.carried.includes('todo'))
})

test('a move for a card that is no longer unfinished is ignored, not refused', () => {
  assert.ok(closeCycles(cycleBoard(), { from: '2026-W39', moves: { done: 'backlog', ghost: 'next' } }, ctx()).ok)
})

test('closing from a cycle that is not the open one is a conflict (criterion 17)', () => {
  assert.equal(code(closeCycles(cycleBoard(), { from: '2026-W38' }, ctx())), 'conflict')
})

test('closing twice is a conflict: the second close finds nothing to close', () => {
  const once = ok(closeCycles(cycleBoard(), { from: '2026-W39' }, ctx())).board
  assert.equal(code(closeCycles(once, { from: '2026-W42' }, ctx())), 'conflict')
})

test('closing appends to the history and leaves the earlier cycles as they were', () => {
  const earlier = { id: '2026-W30', closedAt: NOW_ISO, done: [], canceled: [], carried: [] }
  const { board: after } = ok(closeCycles({ ...cycleBoard(), cycles: [earlier] }, { from: '2026-W39' }, ctx()))
  assert.equal(after.cycles.length, 4)
  assert.deepEqual(after.cycles[0], earlier)
})

test('closeCycles never touches the board it was given', () => {
  const start = cycleBoard()
  const frozen = structuredClone(start)
  closeCycles(start, { from: '2026-W39' }, ctx())
  assert.deepEqual(start, frozen)
})
