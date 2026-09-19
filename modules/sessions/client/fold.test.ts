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
