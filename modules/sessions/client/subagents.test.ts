import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '../types.ts'
import { activity } from './activity.ts'
import { fold, type SubagentRow } from './fold.ts'
import { openSubagents, outcome } from './subagents.ts'

let seq = 0
const T0 = '2026-10-01T10:00:00.000Z'
const T1 = '2026-10-01T10:03:12.000Z'
const state = (s: 'running' | 'finished' | 'cancelled'): SessionEvent => ({ seq: seq++, at: T1, kind: 'state', state: s, reason: undefined })
const started = (task: string): SessionEvent => ({
  seq: seq++,
  at: T0,
  kind: 'subagent',
  phase: 'started',
  task,
  agent: 'general-purpose',
  description: 'count files',
  background: false,
})
const ended = (task: string, status = 'completed'): SessionEvent => ({
  seq: seq++,
  at: T1,
  kind: 'subagent',
  phase: 'ended',
  task,
  ok: status === 'completed',
  status,
  summary: 'report',
})
const shown = (events: readonly SessionEvent[]) => activity(fold(events))

test('open: a start with no end and no state after it, with when it started (criterion 16)', () => {
  const open = openSubagents(shown([state('running'), started('t1')]))
  assert.equal(open.length, 1)
  assert.equal(open[0]?.startedAt, T0)
  assert.equal(openSubagents(shown([state('running'), started('t1'), ended('t1')])).length, 0)
  assert.equal(openSubagents(shown([state('running'), started('t1'), started('t2')])).length, 2)
})

test('nothing is open after its turn, even once the owner replies (criterion 17)', () => {
  assert.equal(openSubagents(shown([state('running'), started('t1'), state('cancelled'), state('running')])).length, 0)
  assert.equal(openSubagents(shown([state('running'), state('cancelled'), started('t1'), state('running')])).length, 0)
})

function row(end: SubagentRow['end']): SubagentRow {
  return { kind: 'subagent', seq: 0, task: 't', agent: 'general-purpose', description: 'd', background: false, startedAt: T0, end }
}

test('done says how long, with the duration format the rest of the client uses (criteria 18, 20)', () => {
  assert.deepEqual(outcome(row({ kind: 'ended', at: T1, ok: true, status: 'completed', summary: '' }), false), {
    text: 'done in 3m 12s',
    tone: 'finished',
  })
})

test('a failure says its status', () => {
  assert.deepEqual(outcome(row({ kind: 'ended', at: T1, ok: false, status: 'failed', summary: '' }), false), {
    text: 'failed: failed',
    tone: 'failed',
  })
})

test('killed and stopped are an interruption, not a failure (criterion 35)', () => {
  for (const status of ['killed', 'stopped']) {
    assert.deepEqual(outcome(row({ kind: 'ended', at: T1, ok: false, status, summary: '' }), false), { text: 'interrupted', tone: 'cancelled' })
  }
})

test('interrupted, and a row with no end once the session has stopped, read the same (criterion 17)', () => {
  assert.deepEqual(outcome(row({ kind: 'interrupted', at: T1 }), true), { text: 'interrupted', tone: 'cancelled' })
  assert.deepEqual(outcome(row(undefined), false), { text: 'interrupted', tone: 'cancelled' })
})

test('the rows fold produces from the real shape go through activity untouched', () => {
  const rows = shown([state('running'), started('t1'), ended('t1'), state('finished')])
  assert.equal(rows.filter((r) => r.kind === 'subagent').length, 1)
})
