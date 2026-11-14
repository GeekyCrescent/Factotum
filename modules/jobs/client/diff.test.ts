import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countLine, wordCount, wordDiff, type DiffPart } from './diff.ts'

/** The parts of one kind, trimmed, joined by `|`. */
const text = (parts: readonly DiffPart[], kind: DiffPart['kind']): string =>
  parts
    .filter((part) => part.kind === kind)
    .map((part) => part.text.trim())
    .join('|')

test('the same text is one unchanged part', () => {
  assert.deepEqual(wordDiff('Hi Sean, thanks', 'Hi Sean, thanks'), [{ kind: 'same', text: 'Hi Sean, thanks' }])
})

test('an added sentence in front is one add, the rest unchanged (the mockup)', () => {
  const parts = wordDiff('Your CRM is built.', "I'm AWS certified and Your CRM is built.")
  assert.deepEqual(parts.map((part) => part.kind), ['add', 'same'])
  assert.equal(text(parts, 'add'), "I'm AWS certified and")
  assert.equal(text(parts, 'same'), 'Your CRM is built.')
})

test('a removed word is a del; a replaced word is a del then an add', () => {
  const removed = wordDiff('a very long letter', 'a long letter')
  assert.equal(text(removed, 'del'), 'very')
  assert.equal(text(removed, 'add'), '')
  assert.equal(text(removed, 'same'), 'a|long letter')
  const replaced = wordDiff('the old line here', 'the new line here')
  assert.deepEqual(
    replaced.map((part) => part.kind),
    ['same', 'del', 'add', 'same'],
  )
  assert.equal(text(replaced, 'del'), 'old')
  assert.equal(text(replaced, 'add'), 'new')
  assert.equal(text(replaced, 'same'), 'the|line here')
})

test('line breaks are kept inside the parts, so the letter reads as it is', () => {
  const parts = wordDiff('Hi Sean,\n\nthanks', 'Hi Sean,\n\nmany thanks')
  assert.equal(parts.map((part) => part.text).join(''), 'Hi Sean,\n\nmany thanks')
  assert.equal(text(parts, 'add'), 'many')
  assert.equal(parts[0]?.text, 'Hi Sean,\n\n')
})

test('joining same+add gives the new text, same+del the old one', () => {
  const before = 'One two three four five six'
  const after = 'One three FOUR five seven six eight'
  const parts = wordDiff(before, after)
  assert.equal(parts.filter((p) => p.kind !== 'del').map((p) => p.text).join(''), after)
  assert.equal(parts.filter((p) => p.kind !== 'add').map((p) => p.text).join(''), before)
})

test('from or to nothing', () => {
  assert.deepEqual(wordDiff('', 'new text'), [{ kind: 'add', text: 'new text' }])
  assert.deepEqual(wordDiff('old text', ''), [{ kind: 'del', text: 'old text' }])
  assert.deepEqual(wordDiff('', ''), [])
})

test('words are counted by runs of non-space', () => {
  assert.equal(wordCount('Hi Sean,\n\nthanks — really.'), 5)
  assert.equal(wordCount('   '), 0)
})

test('the count line: «212 → 158 words»', () => {
  assert.equal(countLine('a b c', 'a b'), '3 → 2 words')
  assert.equal(countLine('a', 'a'), '1 → 1 word')
})
