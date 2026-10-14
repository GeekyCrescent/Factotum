import { test } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { board, NOW, task, ZONE } from '../test-support.ts'
import type { Status, Task } from '../types.ts'
import { boardView, cycleSummaries } from './view.ts'

const STATUSES: readonly Status[] = ['backlog', 'todo', 'in_progress', 'blocked', 'done', 'canceled', 'triage']

test('the view carries the backlog and the open cycle, and only counts triage (criteria 4, 19)', () => {
  const view = boardView(
    board([
      task({ id: 'b', status: 'backlog' }),
      task({ id: 't', status: 'todo', cycle: '2026-W42' }),
      task({ id: 'd', status: 'done', cycle: '2026-W42' }),
      task({ id: 'tri1', status: 'triage' }),
      task({ id: 'tri2', status: 'triage' }),
    ]),
    NOW,
    ZONE,
  )
  assert.deepEqual(view.tasks.map((t) => t.id).sort(), ['b', 'd', 't'])
  assert.equal(view.triage, 2)
  assert.equal(view.timeZone, ZONE)
  assert.equal(view.openCycle, '2026-W42')
  assert.equal(view.currentCycle, '2026-W42')
  assert.equal(view.needsClose, false)
  assert.deepEqual(view.openRange, { start: '2026-10-12', end: '2026-10-18' })
})

test('needsClose compares the cycles as numbers (criterion 14)', () => {
  assert.equal(boardView(board([], { openCycle: '2026-W41' }), NOW, ZONE).needsClose, true)
  // 2027-W01 sorts before 2026-W52 nowhere but in a numeric comparison of the year first.
  const newYear = new Date('2027-01-05T00:00:00Z')
  assert.equal(boardView(board([], { openCycle: '2026-W52' }), newYear, ZONE).needsClose, true)
})

test('the areas, labels and projects in use, once each and sorted, for the filters', () => {
  const view = boardView(
    board([
      task({ id: 'a', area: 'BWR', labels: ['x', 'y'], project: { host: null, siteId: 'factotum' } }),
      task({ id: 'b', area: '8780', labels: ['y'], project: { host: null, siteId: 'factotum' } }),
      task({ id: 'c', status: 'triage', area: 'Vida', project: { host: 'mac', siteId: 'notes' } }),
    ]),
    NOW,
    ZONE,
  )
  assert.deepEqual(view.areas, ['8780', 'BWR', 'Vida'])
  assert.deepEqual(view.labels, ['x', 'y'])
  assert.deepEqual(view.projects, [
    { host: null, siteId: 'factotum' },
    { host: 'mac', siteId: 'notes' },
  ])
})

test('a closed cycle asked by id shows its archived cards, and nothing of the backlog', () => {
  const archived = task({ id: 'old', status: 'done', cycle: '2026-W40' })
  const b = board([task({ id: 'back' })], { cycles: [{ id: '2026-W40', closedAt: NOW.toISOString(), done: [archived], canceled: [], carried: [] }] })
  assert.deepEqual(
    boardView(b, NOW, ZONE, { cycle: '2026-W40' }).tasks.map((t) => t.id),
    ['old'],
  )
  assert.deepEqual(boardView(b, NOW, ZONE, { cycle: '2026-W30' }).tasks, [])
  assert.deepEqual(
    boardView(b, NOW, ZONE, { cycle: '2026-W42' }).tasks.map((t) => t.id),
    ['back'],
  )
})

test('cycle summaries count what was done, canceled and carried, newest first (criterion 18)', () => {
  const b = board([], {
    cycles: [
      { id: '2026-W40', closedAt: 'a', done: [task({ id: 'x' })], canceled: [], carried: ['y', 'z'] },
      { id: '2026-W41', closedAt: 'b', done: [], canceled: [task({ id: 'w' })], carried: [] },
    ],
  })
  assert.deepEqual(cycleSummaries(b), [
    { id: '2026-W41', range: { start: '2026-10-05', end: '2026-10-11' }, closedAt: 'b', done: 0, canceled: 1, carried: 0 },
    { id: '2026-W40', range: { start: '2026-09-28', end: '2026-10-04' }, closedAt: 'a', done: 1, canceled: 0, carried: 2 },
  ])
})

test('criterion 4: the view of a 2 000-card board takes less than 300 ms', () => {
  const tasks: Task[] = Array.from({ length: 2000 }, (_, i) => {
    const status = STATUSES[i % STATUSES.length] as Status
    return task({
      id: `card-${i}`,
      status,
      cycle: status === 'backlog' || status === 'triage' ? null : '2026-W42',
      order: `V${i}`,
      area: `area-${i % 12}`,
      labels: [`l${i % 7}`, `m${i % 5}`],
      project: i % 3 === 0 ? { host: null, siteId: `site-${i % 9}` } : null,
      notes: 'n'.repeat(400),
      subtasks: Array.from({ length: 5 }, (_, j) => ({ id: `s${j}`, text: `subtask ${j}`, done: j % 2 === 0 })),
    })
  })
  const b = board(tasks)
  boardView(b, NOW, ZONE) // warm
  const runs = 5
  const started = performance.now()
  for (let i = 0; i < runs; i++) boardView(b, NOW, ZONE)
  const ms = (performance.now() - started) / runs
  // The route also serialises it: measured too, so §M has the figure the client waits for.
  const serialStart = performance.now()
  const bytes = JSON.stringify(boardView(b, NOW, ZONE)).length
  const withJson = performance.now() - serialStart
  console.log(`criterion 4: view() of 2 000 cards ${ms.toFixed(2)} ms (mean of ${runs}); with JSON ${withJson.toFixed(2)} ms, ${bytes} bytes`)
  assert.ok(ms < 300, `${ms} ms`)
  assert.ok(withJson < 300, `${withJson} ms with JSON`)
})
