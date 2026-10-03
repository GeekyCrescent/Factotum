import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_PROMPT_CHARS, MAX_TERM_CHARS, MAX_TERMS } from './shape.ts'
import { buildPrompt } from './vocabulary.ts'

test('no terms, no prompt: nothing goes to the provider that the owner did not write (guardrail 10)', () => {
  assert.deepEqual(buildPrompt([]), { prompt: '', dropped: 0 })
})

test('the terms are joined with a comma, in the order the owner wrote them', () => {
  assert.deepEqual(buildPrompt(['Muguerza', 'Médica Sur', 'code-review']), { prompt: 'Muguerza, Médica Sur, code-review', dropped: 0 })
})

test('what does not fit goes WHOLE, from the end — the owner writes first what they dictate most (criterion 15)', () => {
  const terms = Array.from({ length: MAX_TERMS }, (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(MAX_TERM_CHARS - 2)}`)
  const { prompt, dropped } = buildPrompt(terms)
  assert.ok(prompt.length <= MAX_PROMPT_CHARS, `${prompt.length}`)
  assert.ok(dropped > 0)
  const kept = prompt.split(', ')
  assert.equal(kept.length + dropped, MAX_TERMS)
  // Whole terms, and the first ones.
  assert.deepEqual(kept, terms.slice(0, kept.length))
})

test('a list exactly at the budget keeps everything', () => {
  const term = 'y'.repeat(MAX_TERM_CHARS)
  const count = Math.floor((MAX_PROMPT_CHARS + 2) / (MAX_TERM_CHARS + 2))
  const { prompt, dropped } = buildPrompt(Array.from({ length: count }, () => term))
  assert.equal(dropped, 0)
  assert.ok(prompt.length <= MAX_PROMPT_CHARS)
})

test('it NEVER passes the budget, whatever it is handed', () => {
  for (const length of [1, 7, MAX_TERM_CHARS, MAX_PROMPT_CHARS + 50]) {
    const { prompt } = buildPrompt(Array.from({ length: 40 }, () => 'z'.repeat(length)))
    assert.ok(prompt.length <= MAX_PROMPT_CHARS, `${length}: ${prompt.length}`)
  }
})
