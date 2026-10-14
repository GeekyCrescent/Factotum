import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NextStatus, Task } from '../types.ts'
import { askedAt, nextRows, nextStage } from './next-model.ts'

function card(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `Card ${id}`,
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

test('nextRows: each suggestion with its card, in order; a card gone or finished since is left out', () => {
  const rows = nextRows(
    [
      { id: 'a', why: 'Due today.' },
      { id: 'gone', why: 'x' },
      { id: 'done', why: 'y' },
      { id: 'b', why: 'In progress.' },
    ],
    [card('a'), card('b', { status: 'in_progress' }), card('done', { status: 'done' })],
  )
  assert.deepEqual(
    rows.map((row) => [row.task.id, row.why]),
    [
      ['a', 'Due today.'],
      ['b', 'In progress.'],
    ],
  )
})

test('askedAt: the time of the answer in the board’s zone, with the day when it is not today', () => {
  // 2026-10-14T23:12Z is Thursday 15, 10:12 in Sydney.
  assert.equal(askedAt('2026-10-14T23:12:00.000Z', 'Australia/Sydney', '2026-10-15'), 'Today, 10:12')
  assert.equal(askedAt('2026-10-14T23:12:00.000Z', 'Australia/Sydney', '2026-10-16'), 'Thu 15 Oct, 10:12')
  assert.equal(askedAt('nonsense', 'Australia/Sydney', '2026-10-15'), '')
})

const IDLE: NextStatus = { running: false, last: null, error: null }

test('nextStage: never asked, thinking, failed, or an answer', () => {
  assert.equal(nextStage(IDLE), 'never')
  assert.equal(nextStage({ ...IDLE, running: true }), 'thinking')
  assert.equal(nextStage({ ...IDLE, error: 'claude gave no answer within 60 s' }), 'failed')
  const last = { at: 'x', items: [], note: '' }
  assert.equal(nextStage({ ...IDLE, last }), 'answer')
  // A failure after an answer still shows the answer, with the failure above it.
  assert.equal(nextStage({ ...IDLE, last, error: 'boom' }), 'answer')
  assert.equal(nextStage({ running: true, last, error: null }), 'thinking')
})
