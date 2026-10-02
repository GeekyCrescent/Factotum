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
// The fifth kind, and the gate's `task` on a result (spec 2026-10-01-subagentes, criterion 14)
// ---------------------------------------------------------------------------

test('a subagent start and end survive a round trip', () => {
  const events: SessionEvent[] = [
    {
      seq: 4,
      at: 'x',
      kind: 'subagent',
      phase: 'started',
      task: 'a1b2',
      agent: 'general-purpose',
      description: 'count files',
      background: false,
    },
    { seq: 5, at: 'x', kind: 'subagent', phase: 'ended', task: 'a1b2', ok: true, status: 'completed', summary: 'done' },
  ]
  for (const event of events) assert.deepEqual(parseLine(serialize(event)), event)
})

test('a result keeps the subagent the gate wrote it for, and one without it has no such key', () => {
  const withTask: SessionEvent = { seq: 6, at: 'x', kind: 'result', name: 'Write', ok: false, summary: 'denied', task: 'a1b2' }
  const without: SessionEvent = { seq: 7, at: 'x', kind: 'result', name: 'Write', ok: false, summary: 'denied' }
  assert.deepEqual(parseLine(serialize(withTask)), withTask)
  const back = parseLine(serialize(without))
  assert.deepEqual(back, without)
  assert.equal(back !== undefined && 'task' in back, false)
})

test('a subagent event with an empty task id is not an event', () => {
  const line = JSON.stringify({ seq: 0, at: 'x', kind: 'subagent', phase: 'ended', task: '', ok: true, status: 'completed', summary: '' })
  assert.equal(parseLine(line), undefined)
})

// ---------------------------------------------------------------------------
// The sixth kind (spec 2026-10-01-preguntas-con-opciones, criterion 25)
// ---------------------------------------------------------------------------

const asked: SessionEvent = {
  seq: 8,
  at: 'x',
  kind: 'questions',
  phase: 'asked',
  id: '0123456789abcdef0123456789abcdef',
  questions: [
    {
      id: 'q1',
      text: 'Which colour?',
      options: [
        { id: 'o1', label: 'red', description: 'warm' },
        { id: 'o2', label: 'green' },
      ],
      multiple: false,
    },
    { id: 'q2', text: 'Which sizes?', options: [{ id: 's', label: 'S' }, { id: 'm', label: 'M' }], multiple: true },
  ],
}

const settled: SessionEvent = {
  seq: 9,
  at: 'x',
  kind: 'questions',
  phase: 'settled',
  id: '0123456789abcdef0123456789abcdef',
  outcome: 'answered',
  answers: [
    { question: 'q1', kind: 'text', text: 'blue, actually' },
    { question: 'q2', kind: 'chosen', options: ['s', 'm'] },
  ],
}

test('a questions asked and settled survive a round trip, with and without a task', () => {
  const events: SessionEvent[] = [
    asked,
    settled,
    { ...asked, task: 'a1b2' },
    { ...settled, task: 'a1b2' },
    { seq: 10, at: 'x', kind: 'questions', phase: 'settled', id: 'abc', outcome: 'expired' },
    { seq: 11, at: 'x', kind: 'questions', phase: 'settled', id: 'abc', outcome: 'shutdown' },
    { ...settled, via: 'screen' },
    { ...settled, via: 'token' },
  ]
  for (const event of events) assert.deepEqual(parseLine(serialize(event)), event)
})

test('a questions event without a task has no task key after the round trip', () => {
  for (const event of [asked, settled]) {
    const back = parseLine(serialize(event))
    assert.notEqual(back, undefined)
    assert.equal(back !== undefined && 'task' in back, false)
  }
})

test('a questions asked with no questions, or a settled with an unknown outcome, is not an event', () => {
  assert.equal(parseLine(JSON.stringify({ ...asked, questions: [] })), undefined)
  assert.equal(parseLine(JSON.stringify({ ...settled, outcome: 'maybe' })), undefined)
  assert.equal(parseLine(JSON.stringify({ ...asked, id: '' })), undefined)
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

// The seventh kind (spec 2026-10-02-servicios-en-segundo-plano, D12; criteria 31, 33)

const serviceStarted: SessionEvent = {
  seq: 20,
  at: 'x',
  kind: 'service',
  phase: 'started',
  id: 's1',
  command: 'python3 -m http.server 8765',
  description: 'static server',
  cwd: '/work/repo',
  maxMinutes: 480,
  pid: 4242,
  task: 'a1b2',
}

test('a service started and ended survive a round trip, with every optional field and without', () => {
  const events: SessionEvent[] = [
    serviceStarted,
    { seq: 21, at: 'x', kind: 'service', phase: 'started', id: 's2', command: 'x', cwd: '/w', maxMinutes: 1, pid: 7 },
    { seq: 22, at: 'x', kind: 'service', phase: 'ended', id: 's1', outcome: 'failed', code: 1 },
    { seq: 23, at: 'x', kind: 'service', phase: 'ended', id: 's2', outcome: 'failed', signal: 'SIGSEGV' },
    { seq: 24, at: 'x', kind: 'service', phase: 'ended', id: 's3', outcome: 'stopped', by: 'owner' },
    { seq: 25, at: 'x', kind: 'service', phase: 'ended', id: 's4', outcome: 'shutdown', reason: 'factotum restarted' },
  ]
  for (const event of events) assert.deepEqual(parseLine(serialize(event)), event)
})

test('a service event that does not fit is not an event: unknown outcome, no pid, empty id, zero minutes', () => {
  const ended = { seq: 1, at: 'x', kind: 'service', phase: 'ended', id: 's1', outcome: 'stopped' }
  assert.equal(parseLine(JSON.stringify({ ...ended, outcome: 'vanished' })), undefined)
  assert.equal(parseLine(JSON.stringify({ ...ended, id: '' })), undefined)
  assert.equal(parseLine(JSON.stringify({ ...ended, by: 'someone' })), undefined)
  const { pid: _pid, ...noPid } = serviceStarted as Extract<SessionEvent, { kind: 'service'; phase: 'started' }>
  assert.equal(parseLine(JSON.stringify(noPid)), undefined)
  assert.equal(parseLine(JSON.stringify({ ...serviceStarted, maxMinutes: 0 })), undefined)
})

test('a reader that does not know a kind drops that line and keeps reading (criterion 33)', () => {
  const text = [serialize(message), JSON.stringify({ seq: 1, at: 'x', kind: 'eighth', what: 'from the future' }), serialize({ ...message, seq: 2 })].join('\n')
  assert.deepEqual(
    parseLog(text).map((event) => event.seq),
    [0, 2],
  )
})
