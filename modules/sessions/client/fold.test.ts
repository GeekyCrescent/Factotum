import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '../types.ts'
import { fold, type Row } from './fold.ts'

let seq = 0
const at = '2026-09-19T10:00:00.000Z'
const tool = (name: string, input: unknown = { file_path: `/f${seq}` }): SessionEvent => ({ seq: seq++, at, kind: 'tool', name, input })
const result = (name: string, ok = true): SessionEvent => ({ seq: seq++, at, kind: 'result', name, ok, summary: ok ? 'ok' : 'boom' })
const call = (name: string, ok = true) => [tool(name), result(name, ok)]
const reads = (n: number, name = 'Read') => Array.from({ length: n }, () => call(name)).flat()
const kinds = (rows: readonly Row[]) => rows.map((row) => (row.kind === 'call' ? row.name : row.kind))

test('five read-only calls in a row stay as they are (criterion 16)', () => {
  assert.deepEqual(kinds(fold(reads(5))), ['Read', 'Read', 'Read', 'Read', 'Read'])
})

test('six fold into one row that says how many and which tools', () => {
  const rows = fold([...reads(3), ...reads(2, 'Grep'), ...reads(1, 'Glob')])
  assert.deepEqual(kinds(rows), ['fold'])
  const only = rows[0]
  assert.ok(only?.kind === 'fold')
  assert.equal(only.calls.length, 6)
  assert.deepEqual(only.names, ['Read', 'Grep', 'Glob'])
})

test('an Edit in the middle is never folded and splits the run', () => {
  assert.deepEqual(kinds(fold([...reads(3), ...call('Edit'), ...reads(3)])), ['Read', 'Read', 'Read', 'Edit', 'Read', 'Read', 'Read'])
  assert.deepEqual(kinds(fold([...reads(6), ...call('Edit'), ...reads(6)])), ['fold', 'Edit', 'fold'])
})

test('a failure in the middle is never folded, even a failed Read', () => {
  const rows = fold([...reads(3), ...call('Read', false), ...reads(3)])
  assert.deepEqual(kinds(rows), ['Read', 'Read', 'Read', 'Read', 'Read', 'Read', 'Read'])
  assert.equal(rows[3]?.kind === 'call' && rows[3].result?.ok, false)
})

test('a call still waiting for its result is never folded', () => {
  const rows = fold([...reads(6), tool('Read')])
  assert.deepEqual(kinds(rows), ['fold', 'Read'])
  assert.equal(rows[1]?.kind === 'call' && rows[1].result, undefined)
})

test('results pair with their calls by name, in order, even when they interleave', () => {
  const rows = fold([tool('Read'), tool('Bash', { command: 'ls' }), result('Bash', false), result('Read')])
  assert.deepEqual(kinds(rows), ['Read', 'Bash'])
  assert.equal(rows[0]?.kind === 'call' && rows[0].result?.ok, true)
  assert.equal(rows[1]?.kind === 'call' && rows[1].result?.ok, false)
})

test('messages and state changes pass through, and a message breaks a run', () => {
  const message: SessionEvent = { seq: seq++, at, kind: 'message', role: 'assistant', text: 'looking' }
  const ended: SessionEvent = { seq: seq++, at, kind: 'state', state: 'finished', reason: undefined }
  assert.deepEqual(kinds(fold([...reads(3), message, ...reads(3), ended])), ['Read', 'Read', 'Read', 'message', 'Read', 'Read', 'Read', 'state'])
})

// ---------------------------------------------------------------------------
// Subagents (spec 2026-10-01-subagentes-visibles)
// ---------------------------------------------------------------------------

const T0 = '2026-10-01T10:00:00.000Z'
const T1 = '2026-10-01T10:03:12.000Z'
const state = (s: 'running' | 'finished' | 'cancelled', when = at): SessionEvent => ({ seq: seq++, at: when, kind: 'state', state: s, reason: undefined })
const started = (task: string, when = T0, agent = 'general-purpose'): SessionEvent => ({
  seq: seq++,
  at: when,
  kind: 'subagent',
  phase: 'started',
  task,
  agent,
  description: `do ${task}`,
  background: false,
})
const ended = (task: string, when = T1, ok = true): SessionEvent => ({
  seq: seq++,
  at: when,
  kind: 'subagent',
  phase: 'ended',
  task,
  ok,
  status: ok ? 'completed' : 'failed',
  summary: 'report',
})
const subRows = (rows: readonly Row[]) => rows.filter((row): row is Extract<Row, { kind: 'subagent' }> => row.kind === 'subagent')

test('a start and its end make ONE subagent row, where it started, with both ends (criterion 18)', () => {
  const rows = fold([state('running'), started('t1'), ended('t1'), state('finished')])
  assert.deepEqual(kinds(rows), ['state', 'subagent', 'state'])
  const [row] = subRows(rows)
  assert.equal(row?.agent, 'general-purpose')
  assert.equal(row?.description, 'do t1')
  assert.equal(row?.startedAt, T0)
  assert.deepEqual(row?.end, { kind: 'ended', at: T1, ok: true, status: 'completed', summary: 'report' })
})

test('a start with no end yet is open; the next state of ANY kind closes it as interrupted, for good (criterion 17)', () => {
  assert.equal(subRows(fold([state('running'), started('t1')]))[0]?.end, undefined)

  // Cancelled, then the owner replies: the old one does not come back.
  const replied = subRows(fold([state('running'), started('t1'), state('cancelled'), state('running')]))
  assert.equal(replied.length, 1)
  assert.equal(replied[0]?.end?.kind, 'interrupted')

  // The stop() race: the start written AFTER the terminal state, then a reply.
  const raced = subRows(fold([state('running'), state('cancelled'), started('t1'), state('running')]))
  assert.equal(raced[0]?.end?.kind, 'interrupted')
  assert.equal(raced.some((row) => row.end === undefined), false)
})

test('an end that arrives after its row was closed changes nothing', () => {
  const [row] = subRows(fold([started('t1'), state('cancelled'), ended('t1')]))
  assert.equal(row?.end?.kind, 'interrupted')
})

test('the same task id started again after it ended is a NEW row (SendMessage)', () => {
  const rows = subRows(fold([started('t1'), ended('t1'), started('t1')]))
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.end?.kind, 'ended')
  assert.equal(rows[1]?.end, undefined)
})

const agent = (ok = true, input: unknown = { subagent_type: 'general-purpose' }) => [tool('Agent', input), result('Agent', ok)]

test('an Agent call whose subagent started is hidden, with its result; one that did not start is not (criterion 19)', () => {
  // One call, one start: hidden.
  assert.deepEqual(kinds(fold([state('running'), ...agent(), started('t1'), ended('t1'), state('finished')])), ['state', 'subagent', 'state'])
  // Two calls, one start in the turn: one call stays.
  const two = fold([state('running'), tool('Agent'), tool('Agent'), started('t1'), result('Agent'), state('finished')])
  assert.deepEqual(kinds(two), ['state', 'Agent', 'subagent', 'state'])
})

test('a FAILED Agent result always shows, as a failed call (criterion 19)', () => {
  const rows = fold([state('running'), ...agent(false), started('t9'), state('finished')])
  const failed = rows.find((row) => row.kind === 'call' && row.name === 'Agent')
  assert.ok(failed?.kind === 'call')
  assert.equal(failed.result?.ok, false)
})

test('the count is per TURN: a start in one turn does not hide an Agent call in another', () => {
  const rows = fold([state('running'), ...agent(), state('finished'), state('running'), started('t1'), state('finished')])
  assert.deepEqual(kinds(rows), ['state', 'Agent', 'state', 'state', 'subagent', 'state'])
})

test('GUARD: a log with no subagent events shows its Agent calls exactly as before (criterion 3)', () => {
  const old: SessionEvent[] = [
    { seq: 100, at, kind: 'message', role: 'user', text: 'go' },
    { seq: 101, at, kind: 'tool', name: 'Agent', input: { subagent_type: 'Explore', description: 'look' } },
    { seq: 102, at, kind: 'result', name: 'Agent', ok: true, summary: 'found it' },
    { seq: 103, at, kind: 'tool', name: 'Bash', input: { command: 'ls' } },
    { seq: 104, at, kind: 'result', name: 'Bash', ok: true, summary: '' },
    { seq: 105, at, kind: 'state', state: 'finished', reason: undefined },
  ]
  assert.deepEqual(fold(old), [
    { kind: 'message', seq: 100, role: 'user', text: 'go' },
    { kind: 'call', seq: 101, name: 'Agent', input: { subagent_type: 'Explore', description: 'look' }, result: { ok: true, summary: 'found it' } },
    { kind: 'call', seq: 103, name: 'Bash', input: { command: 'ls' }, result: { ok: true, summary: '' } },
    { kind: 'state', seq: 105, at, state: 'finished', reason: undefined },
  ])
})

const gate = (name: string, task: string, ok = false): SessionEvent => ({ seq: seq++, at, kind: 'result', name, ok, summary: 'denied: writes outside work: /x', task })

test("a gate result for a subagent never closes the main agent's open call, and says whose it was (criterion 34)", () => {
  const rows = fold([state('running'), started('t1'), tool('Write'), gate('Write', 't1')])
  const calls = rows.filter((row) => row.kind === 'call')
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.kind === 'call' ? calls[0].result : 'x', undefined, "the main agent's Write is still waiting")
  assert.equal(calls[1]?.kind === 'call' ? calls[1].by : '', 'general-purpose')
  assert.equal(calls[1]?.kind === 'call' ? calls[1].result?.ok : true, false)
})

test('a gate result for a task with no start is said to be a subagent', () => {
  const [row] = fold([gate('Write', 'nobody-started-me')])
  assert.equal(row?.kind === 'call' ? row.by : '', 'subagent')
})

test('a gate decision for a subagent is never folded away', () => {
  const rows = fold([started('t1'), ...reads(3), gate('Read', 't1', true), ...reads(3)])
  assert.equal(rows.some((row) => row.kind === 'fold'), false)
  assert.equal(rows.filter((row) => row.kind === 'call' && row.by === 'general-purpose').length, 1)
})

test('an Agent call that FAILED is not the one hidden when another started: it shows whole, with its failure', () => {
  // Review finding: the first call fails (no task_started), the second starts a subagent.
  const rows = fold([state('running'), tool('Agent'), result('Agent', false), tool('Agent'), started('t1'), ended('t1'), result('Agent'), state('finished')])
  const calls = rows.filter((row) => row.kind === 'call')
  assert.equal(calls.length, 1, 'only the failed one shows')
  assert.equal(calls[0]?.kind === 'call' ? calls[0].input !== undefined && calls[0].result?.ok === false : false, true)
  assert.equal(subRows(rows).length, 1)
})

test("a gate result written before its subagent's start still carries the subagent's type", () => {
  // The hook comes over HTTP and the start over stdout: nothing orders the two appends.
  const [first] = fold([gate('Write', 't1'), started('t1')])
  assert.equal(first?.kind === 'call' ? first.by : '', 'general-purpose')
})

test('a repeated start for a task still open adds no second row', () => {
  assert.equal(subRows(fold([started('t1'), started('t1'), ended('t1')])).length, 1)
})
