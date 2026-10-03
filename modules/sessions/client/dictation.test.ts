import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  afterRecording,
  appendDictation,
  dictationErrorText,
  dictationOf,
  dictationProblemOf,
  formatClock,
  microphoneProblemOf,
  MIN_RECORD_MS,
  pickType,
  RECORD_TYPES,
  type DictationProblem,
} from './dictation.ts'

/** What `moduleApi` throws: an Error with the status and the parsed body (apps/web/src/api.ts). */
const failure = (status: number, body?: unknown) => Object.assign(new Error('x'), { status, body })

// --- dictationOf (criterion 19) ----------------------------------------------

test('dictationOf reads the GET as data: on with its ceilings, off with its reason', () => {
  assert.deepEqual(dictationOf({ reply: { on: { maxSeconds: 90, maxBytes: 4_194_304 } } }), { kind: 'on', maxSeconds: 90, maxBytes: 4_194_304 })
  assert.deepEqual(dictationOf({ reply: { off: 'no key' } }), { kind: 'off', reason: 'no key' })
})

test('dictationOf: a shape it does not know is an old daemon, never a guess', () => {
  for (const reply of [undefined, null, 'on', {}, { on: {} }, { on: { maxSeconds: 0, maxBytes: 1 } }, { on: { maxSeconds: 90, maxBytes: '4' } }, { off: 3 }]) {
    assert.deepEqual(dictationOf({ reply }), { kind: 'old' }, JSON.stringify(reply))
  }
})

test('dictationOf: 404 is an old daemon; no answer, a restart or tailscale is unreachable — not "update Factotum"', () => {
  assert.deepEqual(dictationOf({ error: failure(404) }), { kind: 'old' })
  for (const status of [0, 502, 503, 504, 500]) assert.deepEqual(dictationOf({ error: failure(status) }), { kind: 'unreachable' }, `${status}`)
  assert.deepEqual(dictationOf({ error: new Error('no status') }), { kind: 'unreachable' })
})

// --- appendDictation (criterion 20) ------------------------------------------

test('appendDictation adds at the end with ONE space, and keeps what the owner wrote', () => {
  assert.equal(appendDictation('', 'hola'), 'hola')
  assert.equal(appendDictation('abc', 'hola'), 'abc hola')
  assert.equal(appendDictation('abc ', 'hola'), 'abc hola')
  assert.equal(appendDictation('abc\n', 'hola'), 'abc\nhola')
  assert.equal(appendDictation('abc', '  hola  '), 'abc hola')
})

test('appendDictation with nothing to add returns the SAME string, so the box does not re-render for nothing', () => {
  const current = 'what I typed'
  assert.equal(appendDictation(current, ''), current)
  assert.equal(appendDictation(current, '   '), current)
})

// --- pickType (criterion 21) -------------------------------------------------

test('pickType prefers webm-opus, then webm, then mp4', () => {
  assert.equal(pickType(() => true), 'audio/webm;codecs=opus')
  assert.equal(pickType((t) => t !== 'audio/webm;codecs=opus'), 'audio/webm')
  assert.equal(pickType((t) => t === 'audio/mp4'), 'audio/mp4')
  assert.equal(pickType(() => false), undefined)
  assert.deepEqual([...RECORD_TYPES], ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'])
})

test('formatClock is m:ss', () => {
  assert.equal(formatClock(0), '0:00')
  assert.equal(formatClock(59), '0:59')
  assert.equal(formatClock(60), '1:00')
  assert.equal(formatClock(90), '1:30')
})

// --- afterRecording (criteria 34, 36, 37) ------------------------------------

const recording = { durationMs: 5_000, heardVoice: true, meterReliable: true, bytes: 20_000, maxBytes: 4_194_304 }

test('afterRecording: a voice that fits is uploaded', () => {
  assert.equal(afterRecording(recording), 'upload')
})

test('afterRecording: shorter than MIN_RECORD_MS is a double tap, discarded without a word', () => {
  assert.equal(afterRecording({ ...recording, durationMs: MIN_RECORD_MS - 1 }), 'discard')
})

test('afterRecording: a reliable meter that heard nothing sends nothing, and says so (criterion 34)', () => {
  assert.equal(afterRecording({ ...recording, heardVoice: false }), 'nothing-heard')
})

test('afterRecording: an unreliable meter that heard nothing UPLOADS — when in doubt, transcribe (criterion 36)', () => {
  assert.equal(afterRecording({ ...recording, heardVoice: false, meterReliable: false }), 'upload')
})

test('afterRecording: bigger than the server said is not uploaded (criterion 37)', () => {
  assert.equal(afterRecording({ ...recording, bytes: recording.maxBytes + 1 }), 'too-large')
})

// --- dictationProblemOf and the texts (criterion 22) -------------------------

test('dictationProblemOf decides by the BODY: the provider\'s 502 is not tailscale\'s', () => {
  assert.equal(dictationProblemOf(failure(502, { error: { code: 'module-error' }, dictation: { failure: 'credential' } })), 'credential')
  assert.equal(dictationProblemOf(failure(502, { error: { code: 'module-error' }, dictation: { failure: 'quota' } })), 'quota')
  assert.equal(dictationProblemOf(failure(502, { error: { code: 'module-error' }, dictation: { failure: 'failed' } })), 'provider')
  assert.equal(dictationProblemOf(failure(502, undefined)), 'unreachable')
})

test('dictationProblemOf: every other answer has a destination', () => {
  assert.equal(dictationProblemOf(failure(409, { error: { code: 'conflict' }, dictation: { off: 'no key' } })), 'off')
  assert.equal(dictationProblemOf(failure(413)), 'too-large')
  assert.equal(dictationProblemOf(failure(500)), 'host')
  assert.equal(dictationProblemOf(failure(404)), 'old')
  for (const status of [0, 503, 504]) assert.equal(dictationProblemOf(failure(status)), 'unreachable', `${status}`)
  assert.equal(dictationProblemOf(failure(400, { error: { code: 'invalid-request' } })), 'unknown')
  assert.equal(dictationProblemOf(failure(409, { error: { code: 'conflict' } })), 'unknown')
  assert.equal(dictationProblemOf(failure(418)), 'unknown')
  assert.equal(dictationProblemOf('not even an error'), 'unreachable')
})

test('microphoneProblemOf: a refusal is "denied", anything else from the device is "no microphone"', () => {
  assert.equal(microphoneProblemOf(Object.assign(new Error(''), { name: 'NotAllowedError' })), 'denied')
  assert.equal(microphoneProblemOf(Object.assign(new Error(''), { name: 'SecurityError' })), 'denied')
  for (const name of ['NotFoundError', 'NotReadableError', 'OverconstrainedError', 'TypeError']) {
    assert.equal(microphoneProblemOf(Object.assign(new Error(''), { name })), 'no-microphone', name)
  }
})

const ALL: readonly DictationProblem[] = [
  'credential', 'quota', 'provider', 'timeout', 'unreachable', 'too-large', 'host',
  'off', 'old', 'denied', 'no-microphone', 'unsupported', 'nothing-heard', 'unknown',
]

test('every problem has its own text', () => {
  const texts = ALL.map((problem) => dictationErrorText(problem))
  assert.equal(new Set(texts).size, ALL.length)
  for (const text of texts) assert.ok(text.length > 0)
})

test('the provider\'s three say "provider"; the microphone\'s never do (criterion 22)', () => {
  for (const problem of ['credential', 'quota', 'provider'] as const) assert.match(dictationErrorText(problem), /provider/)
  for (const problem of ['denied', 'no-microphone', 'unsupported', 'nothing-heard'] as const) assert.doesNotMatch(dictationErrorText(problem), /provider/)
})

test('off carries the host\'s reason, unknown the server\'s message', () => {
  assert.match(dictationErrorText('off', 'no API key file'), /no API key file/)
  assert.match(dictationErrorText('unknown', 'type must be one of'), /type must be one of/)
})
