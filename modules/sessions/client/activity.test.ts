import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionState } from '../types.ts'
import { activity, type Shown } from './activity.ts'
import type { Row } from './fold.ts'

let seq = 0
const at = '2026-09-29T10:00:00.000Z'
const state = (s: SessionState, reason?: string): Row => ({ kind: 'state', seq: seq++, at, state: s, reason })
const said = (text: string): Row => ({ kind: 'message', seq: seq++, role: 'assistant', text })
const asked = (text: string): Row => ({ kind: 'message', seq: seq++, role: 'user', text })
const shape = (rows: readonly Shown[]) =>
  rows.map((row) => (row.kind === 'activity' ? `activity:${row.entries.map((e) => e.label).join('>')}` : row.kind))

test('one turn: the start and the end become one activity row where the end was', () => {
  const rows = activity([asked('go'), state('running'), said('done'), state('finished')])
  assert.deepEqual(shape(rows), ['message', 'message', 'activity:Started>Finished'])
})

test('a second turn says Resumed, and gets its own row', () => {
  const rows = activity([asked('a'), state('running'), said('x'), state('finished'), asked('b'), state('running'), said('y'), state('finished')])
  assert.deepEqual(shape(rows), ['message', 'message', 'activity:Started>Finished', 'message', 'message', 'activity:Resumed>Finished'])
})

test('a turn still running shows no activity row yet', () => {
  const rows = activity([asked('go'), state('running'), said('working')])
  assert.deepEqual(shape(rows), ['message', 'message'])
})

test('the row is named after how the turn ended, with the reason when there is one', () => {
  const [, row] = activity([asked('go'), state('running'), state('failed', 'agent exited 1')])
  assert.equal(row?.kind === 'activity' ? row.summary : '', 'Failed: agent exited 1')
  const [, cancelled] = activity([asked('go'), state('running'), state('cancelled')])
  assert.equal(cancelled?.kind === 'activity' ? cancelled.summary : '', 'Cancelled')
})

test('the row takes the seq of the state that ended the turn, so keys stay stable as it grows', () => {
  const end = state('finished')
  const [row] = activity([state('running'), end])
  assert.equal(row?.kind === 'activity' ? row.seq : -1, end.seq)
  assert.equal(row?.kind === 'activity' ? row.tone : '', 'finished')
})

test('an end with no start before it (an old log) is still a row of its own', () => {
  assert.deepEqual(shape(activity([said('hi'), state('finished')])), ['message', 'activity:Finished'])
})

test('rows that are not states pass through untouched and in order', () => {
  const call: Row = { kind: 'call', seq: seq++, name: 'Read', input: { file_path: '/a' }, result: { ok: true, summary: 'ok' } }
  const rows = activity([state('running'), call, said('x')])
  assert.deepEqual(rows, [call, rows[1]])
  assert.equal(rows[1]?.kind, 'message')
})
