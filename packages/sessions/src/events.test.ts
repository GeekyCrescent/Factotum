import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTerminal, parseLine, parseLog, serialize, stateFrom } from './events.ts'
import type { SessionEvent } from './types.ts'

const message: SessionEvent = { seq: 0, at: '2026-09-15T00:00:00.000Z', kind: 'message', role: 'assistant', text: 'hi' }

test('an event round-trips through serialize and parseLine', () => {
  assert.deepEqual(parseLine(serialize(message)), message)
})

test('serialize ends in a newline, because the file is line-delimited', () => {
  assert.equal(serialize(message).endsWith('\n'), true)
  assert.equal(serialize(message).trimEnd().includes('\n'), false)
})

test('all four kinds survive a round trip', () => {
  const events: SessionEvent[] = [
    message,
    { seq: 1, at: 'x', kind: 'tool', name: 'Write', input: { file_path: '/a/b' } },
    { seq: 2, at: 'x', kind: 'result', name: 'Write', ok: true, summary: 'wrote 7 bytes' },
    { seq: 3, at: 'x', kind: 'state', state: 'finished', reason: undefined },
  ]
  for (const event of events) assert.deepEqual(parseLine(serialize(event)), event)
})

// ---------------------------------------------------------------------------
// Criterion 11: a truncated line is skipped, it does not take anything down
// ---------------------------------------------------------------------------

test('a line truncated by a crash returns nothing instead of throwing', () => {
  const half = serialize(message).slice(0, 20)
  assert.equal(parseLine(half), undefined)
})

test('an empty line returns nothing', () => {
  assert.equal(parseLine(''), undefined)
  assert.equal(parseLine('   \n'), undefined)
})

test('valid JSON that is not an event returns nothing, so a fifth kind costs nothing', () => {
  assert.equal(parseLine('{"kind":"telemetry","seq":0,"at":"x"}'), undefined)
})

test('a log whose LAST line was truncated still yields every complete line before it', () => {
  const text =
    serialize({ ...message, seq: 0 }) +
    serialize({ ...message, seq: 1 }) +
    serialize({ ...message, seq: 2 }).slice(0, 15)
  const parsed = parseLog(text)
  assert.deepEqual(parsed.map((e) => e.seq), [0, 1])
})

test('a log with a corrupt line in the MIDDLE keeps the lines after it', () => {
  const text =
    serialize({ ...message, seq: 0 }) + 'not json at all\n' + serialize({ ...message, seq: 1 })
  assert.deepEqual(parseLog(text).map((e) => e.seq), [0, 1])
})

// ---------------------------------------------------------------------------
// stateFrom — the log is the source of truth, so the state is derived from it
// ---------------------------------------------------------------------------

test('the state is the LAST state event in the log', () => {
  const events: SessionEvent[] = [
    { seq: 0, at: 'x', kind: 'state', state: 'running', reason: undefined },
    message,
    { seq: 2, at: 'x', kind: 'state', state: 'cancelled', reason: 'the owner said so' },
  ]
  assert.equal(stateFrom(events, 'failed'), 'cancelled')
})

test('with no state event at all, the fallback wins', () => {
  assert.equal(stateFrom([message], 'running'), 'running')
})

test('running is the only state that is not terminal', () => {
  assert.equal(isTerminal('running'), false)
  assert.equal(isTerminal('finished'), true)
  assert.equal(isTerminal('failed'), true)
  assert.equal(isTerminal('cancelled'), true)
})
