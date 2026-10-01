import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_DESCRIPTION_CHARS,
  MAX_FREE_TEXT_CHARS,
  MAX_LABEL_CHARS,
  MAX_OPTIONS,
  MAX_QUESTION_CHARS,
  MAX_QUESTIONS,
  clipUnits,
  parseAnswers,
  questionSchema,
  sanitize,
  type Question,
} from './shape.ts'

function ok(raw: unknown): readonly Question[] {
  const result = sanitize(raw)
  if ('error' in result) throw new Error(`expected a batch, got: ${result.error}`)
  return result
}

function refused(raw: unknown): string {
  const result = sanitize(raw)
  if (!('error' in result)) throw new Error('expected a refusal, got a batch')
  return result.error
}

const two = [{ label: 'red' }, { label: 'green' }]

// --- sanitize: what is forgiven ------------------------------------------------------

test('a well-formed batch comes back with ids filled in and multiple defaulting to false', () => {
  const [question] = ok({ questions: [{ text: 'Which colour?', options: two }] })
  assert.deepEqual(question, {
    id: 'q1',
    text: 'Which colour?',
    options: [
      { id: 'o1', label: 'red' },
      { id: 'o2', label: 'green' },
    ],
    multiple: false,
  })
})

test('multiple is true only when it is literally true', () => {
  assert.equal(ok({ questions: [{ text: 'x', options: two, multiple: true }] })[0]?.multiple, true)
  assert.equal(ok({ questions: [{ text: 'x', options: two, multiple: 'yes' }] })[0]?.multiple, false)
})

test('ids the agent gave are kept; missing, repeated or oversized ones are generated', () => {
  const batch = ok({
    questions: [
      { id: 'colour', text: 'a', options: [{ id: 'r', label: 'red' }, { id: 'r', label: 'rose' }] },
      { id: 'colour', text: 'b', options: two },
      { id: 'x'.repeat(65), text: 'c', options: two },
    ],
  })
  assert.deepEqual(batch.map((q) => q.id), ['colour', 'q2', 'q3'])
  assert.deepEqual(batch[0]?.options.map((o) => o.id), ['r', 'o2'])
})

test('text over its cap is clipped, not refused (criterion 7)', () => {
  const [question] = ok({
    questions: [
      {
        text: 'q'.repeat(MAX_QUESTION_CHARS + 50),
        options: [{ label: 'l'.repeat(MAX_LABEL_CHARS + 5), description: 'd'.repeat(MAX_DESCRIPTION_CHARS + 5) }, { label: 'b' }],
      },
    ],
  })
  assert.equal(question?.text.length, MAX_QUESTION_CHARS)
  assert.equal(question?.options[0]?.label.length, MAX_LABEL_CHARS)
  assert.equal(question?.options[0]?.description?.length, MAX_DESCRIPTION_CHARS)
  assert.equal(questionSchema.safeParse(question).success, true)
})

test('clipping never splits a surrogate pair, and what it returns passes the schema (criterion 7)', () => {
  // 59 ASCII + one emoji (two UTF-16 units) = 61 units: one too many for a 60-unit label.
  const label = `${'a'.repeat(MAX_LABEL_CHARS - 1)}😀`
  const [question] = ok({ questions: [{ text: '😀'.repeat(MAX_QUESTION_CHARS), options: [{ label }, { label: 'b' }] }] })
  assert.equal(question?.options[0]?.label, 'a'.repeat(MAX_LABEL_CHARS - 1))
  assert.ok((question?.text.length ?? 0) <= MAX_QUESTION_CHARS)
  assert.ok(!/[\uD800-\uDBFF]$/.test(question?.text ?? ''), 'a high surrogate was left dangling')
  assert.equal(questionSchema.safeParse(question).success, true)
})

test('clipUnits measures UTF-16 units and stops before a character that does not fit whole', () => {
  assert.equal(clipUnits('abc', 5), 'abc')
  assert.equal(clipUnits('ab😀', 3), 'ab')
  assert.equal(clipUnits('ab😀', 4), 'ab😀')
})

test('whitespace around the texts is trimmed, and an empty description is dropped', () => {
  const [question] = ok({ questions: [{ text: '  Which?  ', options: [{ label: ' red ', description: '   ' }, { label: 'b' }] }] })
  assert.equal(question?.text, 'Which?')
  assert.deepEqual(question?.options[0], { id: 'o1', label: 'red' })
})

// --- sanitize: what cannot be fixed without inventing (criterion 6) ------------------

test('no questions, or no questions field, is refused', () => {
  assert.match(refused({ questions: [] }), /at least one question/)
  assert.match(refused({}), /at least one question/)
  assert.match(refused(undefined), /at least one question/)
})

test(`more than ${MAX_QUESTIONS} questions is refused, and says to split the decision`, () => {
  const many = Array.from({ length: MAX_QUESTIONS + 1 }, () => ({ text: 'x', options: two }))
  assert.match(refused({ questions: many }), new RegExp(`up to ${MAX_QUESTIONS}.*split`, 'i'))
})

test('a question with fewer than two options, or more than the cap, is refused and named', () => {
  assert.match(refused({ questions: [{ text: 'Lonely?', options: [{ label: 'yes' }] }] }), /Lonely\?/)
  const seven = Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => ({ label: `o${i}` }))
  assert.match(refused({ questions: [{ text: 'Crowded?', options: seven }] }), /Crowded\?/)
})

test('a question without text, or an option without a label, is refused', () => {
  assert.match(refused({ questions: [{ text: '   ', options: two }] }), /text/)
  assert.match(refused({ questions: [{ text: 'x', options: [{ label: '' }, { label: 'b' }] }] }), /label/)
})

// --- parseAnswers (criteria 12, 13, 14) ----------------------------------------------

const batch: readonly Question[] = [
  { id: 'q1', text: 'One?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], multiple: false },
  { id: 'q2', text: 'Many?', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }, { id: 'z', label: 'Z' }], multiple: true },
  { id: 'q3', text: 'Free?', options: [{ id: 'm', label: 'M' }, { id: 'n', label: 'N' }], multiple: false },
]

function answers(body: unknown) {
  const result = parseAnswers(batch, body)
  if ('error' in result) throw new Error(`expected answers, got: ${result.error}`)
  return result
}

function invalid(body: unknown): string {
  const result = parseAnswers(batch, body)
  if (!('error' in result)) throw new Error('expected a refusal')
  return result.error
}

test('answers come back in the order of the batch, whatever order they were sent in', () => {
  const got = answers({
    answers: [
      { question: 'q3', kind: 'text', text: 'neither' },
      { question: 'q1', kind: 'chosen', options: ['b'] },
    ],
  })
  assert.deepEqual(got.map((a) => a.question), ['q1', 'q2', 'q3'])
})

test('a question left out of the body is an explicit none (criterion 12)', () => {
  const got = answers({ answers: [{ question: 'q1', kind: 'chosen', options: ['a'] }] })
  assert.deepEqual(got[1], { question: 'q2', kind: 'none' })
  assert.deepEqual(got[2], { question: 'q3', kind: 'none' })
})

test('a multiple-choice question takes several options, exactly those (criterion 13)', () => {
  const got = answers({ answers: [{ question: 'q2', kind: 'chosen', options: ['x', 'z'] }] })
  assert.deepEqual(got[1], { question: 'q2', kind: 'chosen', options: ['x', 'z'] })
})

test('a single-choice question with two options is refused (criterion 13)', () => {
  assert.match(invalid({ answers: [{ question: 'q1', kind: 'chosen', options: ['a', 'b'] }] }), /One\?/)
})

test('zero options chosen is none, not a refusal', () => {
  assert.deepEqual(answers({ answers: [{ question: 'q2', kind: 'chosen', options: [] }] })[1], { question: 'q2', kind: 'none' })
})

test('an option that belongs to another question is refused (criterion 14)', () => {
  assert.match(invalid({ answers: [{ question: 'q1', kind: 'chosen', options: ['x'] }] }), /option/)
})

test('a question that is not in the batch, or answered twice, is refused (criterion 14)', () => {
  assert.match(invalid({ answers: [{ question: 'q9', kind: 'none' }] }), /not in this batch/)
  assert.match(
    invalid({ answers: [{ question: 'q1', kind: 'none' }, { question: 'q1', kind: 'chosen', options: ['a'] }] }),
    /twice/,
  )
})

test('an empty free text is refused; a long one is clipped (criterion 14)', () => {
  assert.match(invalid({ answers: [{ question: 'q3', kind: 'text', text: '   ' }] }), /empty/)
  const got = answers({ answers: [{ question: 'q3', kind: 'text', text: 't'.repeat(MAX_FREE_TEXT_CHARS + 10) }] })
  const third = got[2]
  assert.equal(third?.kind, 'text')
  assert.equal(third?.kind === 'text' ? third.text.length : 0, MAX_FREE_TEXT_CHARS)
})

test('a body that is not { answers: [...] }, or an answer of an unknown kind, is refused', () => {
  assert.match(invalid(undefined), /answers/)
  assert.match(invalid({ answers: 'all of them' }), /answers/)
  assert.match(invalid({ answers: [{ question: 'q1', kind: 'maybe' }] }), /kind/)
})
