import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Question } from '../types.ts'
import type { QuestionsRow } from './fold.ts'
import {
  answerPath,
  answeredCount,
  askedBy,
  body,
  choose,
  describeRow,
  emptyDraft,
  howOf,
  onKey,
  questionsLabel,
  sendLabel,
  sheetState,
  textOf,
  writeText,
  type Focus,
  type KeyInput,
} from './questions.ts'

const single: Question = { id: 'q1', text: 'Which colour?', options: [{ id: 'r', label: 'red' }, { id: 'g', label: 'green' }, { id: 'b', label: 'blue' }], multiple: false }
const multi: Question = { id: 'q2', text: 'Which sizes?', options: [{ id: 's', label: 'S' }, { id: 'm', label: 'M' }, { id: 'l', label: 'L' }], multiple: true }
const third: Question = { id: 'q3', text: 'Deploy?', options: [{ id: 'y', label: 'yes' }, { id: 'n', label: 'no' }], multiple: false }
const batch = [single, multi, third]

// ---------------------------------------------------------------------------
// The draft (criterion 30)
// ---------------------------------------------------------------------------

test('an empty draft answers nothing, and its body says none for every question, in order', () => {
  const draft = emptyDraft(batch)
  assert.equal(answeredCount(draft), 0)
  assert.deepEqual(body(draft, batch), {
    answers: [
      { question: 'q1', kind: 'none' },
      { question: 'q2', kind: 'none' },
      { question: 'q3', kind: 'none' },
    ],
  })
})

test('on a single question, choosing replaces; on a multiple one, it toggles', () => {
  let draft = choose(emptyDraft(batch), single, 'r')
  draft = choose(draft, single, 'g')
  draft = choose(draft, multi, 's')
  draft = choose(draft, multi, 'l')
  draft = choose(draft, multi, 's')
  assert.deepEqual(body(draft, batch).answers.slice(0, 2), [
    { question: 'q1', kind: 'chosen', options: ['g'] },
    { question: 'q2', kind: 'chosen', options: ['l'] },
  ])
  assert.equal(answeredCount(draft), 2)
})

test('un-ticking the last option of a multiple question leaves it unanswered, not an empty choice', () => {
  const draft = choose(choose(emptyDraft(batch), multi, 'm'), multi, 'm')
  assert.deepEqual(body(draft, batch).answers[1], { question: 'q2', kind: 'none' })
  assert.equal(answeredCount(draft), 0)
})

test('free text replaces the choice, a choice replaces the text, and blank text is no answer', () => {
  let draft = writeText(choose(emptyDraft(batch), single, 'r'), 'q1', '  teal  ')
  assert.deepEqual(body(draft, batch).answers[0], { question: 'q1', kind: 'text', text: 'teal' })
  assert.equal(textOf(draft, 'q1'), '  teal  ', 'the field keeps what was typed')
  draft = choose(draft, single, 'b')
  assert.deepEqual(body(draft, batch).answers[0], { question: 'q1', kind: 'chosen', options: ['b'] })
  draft = writeText(draft, 'q1', '   ')
  assert.deepEqual(body(draft, batch).answers[0], { question: 'q1', kind: 'chosen', options: ['b'] }, 'blank text leaves the choice')
  draft = writeText(writeText(emptyDraft(batch), 'q3', 'maybe'), 'q3', '')
  assert.deepEqual(body(draft, batch).answers[2], { question: 'q3', kind: 'none' })
})

test('the draft is immutable: an old draft does not change', () => {
  const before = emptyDraft(batch)
  const after = choose(before, single, 'r')
  assert.equal(answeredCount(before), 0)
  assert.equal(answeredCount(after), 1)
  const typed = writeText(after, 'q2', 'XL')
  assert.deepEqual(body(after, batch).answers[1], { question: 'q2', kind: 'none' })
  assert.deepEqual(body(typed, batch).answers[1], { question: 'q2', kind: 'text', text: 'XL' })
})

test('the send button says how many are left, and sending with gaps is allowed', () => {
  assert.equal(sendLabel(emptyDraft(batch), batch), 'Send (3 unanswered)')
  assert.equal(sendLabel(choose(emptyDraft(batch), single, 'r'), batch), 'Send (2 unanswered)')
  let all = choose(choose(choose(emptyDraft(batch), single, 'r'), multi, 's'), third, 'y')
  assert.equal(sendLabel(all, batch), 'Send')
  all = writeText(all, 'q3', 'only Friday')
  assert.equal(sendLabel(all, batch), 'Send')
})

// ---------------------------------------------------------------------------
// The keyboard (criterion 31)
// ---------------------------------------------------------------------------

const key = (k: string, extra: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  keyCode: 0,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  ...extra,
})
const at = (question: number, option: number): Focus => ({ question, option })

test('↑/↓ move between the options, and one past the last is "Other…"', () => {
  const draft = emptyDraft(batch)
  assert.deepEqual(onKey(batch, draft, at(0, 0), key('ArrowDown'), false).focus, at(0, 1))
  assert.deepEqual(onKey(batch, draft, at(0, 2), key('ArrowDown'), false).focus, at(0, 3))
  assert.deepEqual(onKey(batch, draft, at(0, 3), key('ArrowDown'), false).focus, at(0, 3))
  assert.deepEqual(onKey(batch, draft, at(0, 0), key('ArrowUp'), false).focus, at(0, 0))
  assert.equal(onKey(batch, draft, at(0, 0), key('ArrowDown'), false).handled, true)
})

test('1–6 choose in the current question; a number past its options does nothing', () => {
  const draft = emptyDraft(batch)
  const two = onKey(batch, draft, at(1, 0), key('2'), false)
  assert.deepEqual(body(two.draft, batch).answers[1], { question: 'q2', kind: 'chosen', options: ['m'] })
  assert.deepEqual(two.focus, at(1, 1))
  const four = onKey(batch, draft, at(0, 0), key('4'), false)
  assert.equal(four.handled, false)
  assert.equal(answeredCount(four.draft), 0)
})

test('Space and Enter choose on a single question and toggle on a multiple one; on "Other…" they open the text', () => {
  let draft = emptyDraft(batch)
  draft = onKey(batch, draft, at(1, 0), key(' '), false).draft
  draft = onKey(batch, draft, at(1, 2), key('Enter'), false).draft
  draft = onKey(batch, draft, at(1, 0), key(' '), false).draft
  assert.deepEqual(body(draft, batch).answers[1], { question: 'q2', kind: 'chosen', options: ['l'] })
  const other = onKey(batch, draft, at(1, 3), key('Enter'), false)
  assert.equal(other.editText, true)
  assert.equal(other.draft, draft)
})

test('Tab and Shift+Tab move between questions; past the ends they let the browser have it', () => {
  const draft = emptyDraft(batch)
  assert.deepEqual(onKey(batch, draft, at(0, 2), key('Tab'), false).focus, at(1, 0))
  assert.deepEqual(onKey(batch, draft, at(1, 1), key('Tab', { shiftKey: true }), false).focus, at(0, 0))
  assert.equal(onKey(batch, draft, at(2, 0), key('Tab'), false).handled, false)
  assert.equal(onKey(batch, draft, at(0, 0), key('Tab', { shiftKey: true }), false).handled, false)
})

test('⌘+Enter and Ctrl+Enter send, also from inside the free text', () => {
  const draft = emptyDraft(batch)
  assert.equal(onKey(batch, draft, at(0, 0), key('Enter', { metaKey: true }), false).send, true)
  assert.equal(onKey(batch, draft, at(0, 0), key('Enter', { ctrlKey: true }), false).send, true)
  assert.equal(onKey(batch, draft, at(0, 3), key('Enter', { metaKey: true }), true).send, true)
  assert.equal(onKey(batch, draft, at(0, 0), key('Enter'), false).send, false)
})

test('inside the free text only ⌘/Ctrl+Enter and Escape count: arrows, digits, Space and Tab are the field’s', () => {
  const draft = emptyDraft(batch)
  for (const k of ['ArrowUp', 'ArrowDown', '1', ' ', 'Enter', 'Tab']) {
    const out = onKey(batch, draft, at(0, 3), key(k), true)
    assert.equal(out.handled, false, k)
    assert.equal(out.draft, draft, k)
  }
  const escape = onKey(batch, draft, at(0, 3), key('Escape'), true)
  assert.equal(escape.handled, true)
  assert.equal(escape.leaveText, true)
})

test('during IME composition, or with keyCode 229, no key does anything', () => {
  const draft = emptyDraft(batch)
  for (const input of [key('1', { isComposing: true }), key('Enter', { keyCode: 229 }), key('Enter', { metaKey: true, isComposing: true })]) {
    const out = onKey(batch, draft, at(0, 0), input, false)
    assert.equal(out.handled, false)
    assert.equal(out.send, false)
    assert.equal(out.draft, draft)
  }
})

// ---------------------------------------------------------------------------
// Who asked (criterion 24), and what the dock says once it is over (design D10)
// ---------------------------------------------------------------------------

test('a subagent with a start in the log is named by its type; without one, "a subagent"; the main agent, nobody', () => {
  const agents = new Map([['a1', 'general-purpose']])
  assert.equal(askedBy('a1', agents), 'asked by general-purpose')
  assert.equal(askedBy('zz', agents), 'asked by a subagent')
  assert.equal(askedBy(undefined, agents), undefined)
})

test('the area after answering, with the URL still there: "Answered", and the sheet does NOT reopen', () => {
  assert.deepEqual(sheetState({ kind: 'over', how: 'answered' }), { opens: false, notice: 'Answered' })
  assert.deepEqual(sheetState({ kind: 'over', how: 'expired' }), { opens: false, notice: 'These questions expired' })
  assert.deepEqual(sheetState({ kind: 'over', how: 'cancelled' }), { opens: false, notice: 'These questions were cancelled' })
  assert.deepEqual(sheetState({ kind: 'unknown' }), { opens: false, notice: 'These questions are over' })
  assert.deepEqual(sheetState({ kind: 'loading' }), { opens: false, notice: 'Questions for you' })
  assert.deepEqual(sheetState({ kind: 'pending' }), { opens: true, notice: 'Questions for you' })
})

test('a 409 says how the batch ended; anything else says nothing', () => {
  assert.equal(howOf({ status: 409, body: { how: 'expired' } }), 'expired')
  assert.equal(howOf({ status: 409, body: { how: 'answered' } }), 'answered')
  assert.equal(howOf({ status: 409, body: { how: 'sideways' } }), undefined)
  assert.equal(howOf({ status: 404, body: { how: 'expired' } }), undefined)
  assert.equal(howOf(new Error('network')), undefined)
})

test('how many questions, said for the drawer', () => {
  assert.equal(questionsLabel(1), '1 question')
  assert.equal(questionsLabel(4), '4 questions')
  assert.equal(questionsLabel(undefined), 'Questions for you')
})

// ---------------------------------------------------------------------------
// The row in the log (design D13)
// ---------------------------------------------------------------------------

const rowOf = (end: QuestionsRow['end'], by?: string): QuestionsRow => ({
  kind: 'questions',
  seq: 1,
  id: 'b1',
  questions: [single, multi, third],
  by,
  askedAt: '2026-10-01T00:00:00.000Z',
  end,
})

test('an open batch in a running session is waiting for the owner', () => {
  const row = describeRow(rowOf(undefined), true)
  assert.equal(row.status, 'Waiting for your answer')
  assert.equal(row.tone, 'waiting')
  assert.deepEqual(row.lines, [])
})

test('an answered batch says each question with its answer, by LABEL, and the gaps as unanswered', () => {
  const row = describeRow(
    rowOf({
      kind: 'settled',
      at: 'x',
      outcome: 'answered',
      answers: [
        { question: 'q1', kind: 'chosen', options: ['g'] },
        { question: 'q2', kind: 'chosen', options: ['s', 'l'] },
        { question: 'q3', kind: 'none' },
      ],
    }),
    false,
  )
  assert.equal(row.tone, 'ok')
  assert.deepEqual(row.lines, [
    { question: 'Which colour?', answer: 'green', unanswered: false },
    { question: 'Which sizes?', answer: 'S, L', unanswered: false },
    { question: 'Deploy?', answer: 'unanswered', unanswered: true },
  ])
})

test('free text is shown as written; expired, cancelled, shutdown and interrupted are said and muted', () => {
  const text = describeRow(rowOf({ kind: 'settled', at: 'x', outcome: 'answered', answers: [{ question: 'q1', kind: 'text', text: 'teal' }] }), false)
  assert.deepEqual(text.lines[0], { question: 'Which colour?', answer: '“teal”', unanswered: false })
  assert.equal(describeRow(rowOf({ kind: 'settled', at: 'x', outcome: 'expired', answers: undefined }), false).status, 'Nobody answered in time')
  for (const [end, status] of [
    [{ kind: 'settled', at: 'x', outcome: 'cancelled', answers: undefined }, 'Cancelled with the session'],
    [{ kind: 'settled', at: 'x', outcome: 'shutdown', answers: undefined }, 'Factotum stopped'],
    [{ kind: 'interrupted', at: 'x' }, 'Interrupted'],
  ] as const) {
    const row = describeRow(rowOf(end), false)
    assert.equal(row.status, status)
    assert.equal(row.tone, 'muted')
  }
})

test('an answer from a screen without the notification says so', () => {
  const end = { kind: 'settled' as const, at: 'x', outcome: 'answered' as const, answers: [], via: 'screen' as const }
  assert.equal(describeRow(rowOf(end), false).status, 'Answered without the notification')
  assert.equal(describeRow(rowOf({ ...end, via: 'token' }), false).status, 'Answered')
  assert.equal(describeRow(rowOf({ ...end, via: undefined }), false).status, 'Answered')
})

test('the answer goes by token when there is one, else by session and batch', () => {
  assert.equal(answerPath({ token: 'T', sessionId: 's', batch: 'b' }), 'questions/T/answer')
  assert.equal(answerPath({ sessionId: 's', batch: 'b' }), 'sessions/s/questions/b/answer')
})
