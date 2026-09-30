import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTitlePrompt, ENVELOPE, NO_TITLE, TITLE_TAG, TITLER_INPUT_CHARS } from './prompt.ts'

test('the envelope opens with <task> and asks for the tag and the no-title answer', () => {
  assert.ok(ENVELOPE.startsWith('<task>'))
  assert.ok(ENVELOPE.includes(`<${TITLE_TAG}>`))
  assert.ok(ENVELOPE.includes(NO_TITLE))
})

test('the prompt NEVER starts with "/", even when the owner’s does (criterion 18)', () => {
  // A leading slash would make the CLI run that command or skill instead of titling.
  const prompt = buildTitlePrompt('/create-spec something')
  assert.ok(!prompt.startsWith('/'))
  assert.ok(prompt.startsWith('<task>'))
})

test('the owner’s text goes AFTER the envelope, behind a marker', () => {
  const prompt = buildTitlePrompt('plan a marathon')
  assert.ok(prompt.startsWith(ENVELOPE))
  assert.ok(prompt.endsWith('\n\nowner: plan a marathon'))
})

test('a long prompt is cut to TITLER_INPUT_CHARS (criterion 20)', () => {
  const prompt = buildTitlePrompt('x'.repeat(50_000))
  const owner = prompt.slice(prompt.indexOf('\n\nowner: ') + '\n\nowner: '.length)
  assert.equal(owner.length, TITLER_INPUT_CHARS)
})
