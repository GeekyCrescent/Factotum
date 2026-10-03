import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDictation } from './config.ts'
import { DEFAULT_MODEL, MAX_TERM_CHARS, MAX_TERMS } from './shape.ts'

test('no block at all is not an error: it is how a fresh clone looks', () => {
  assert.deepEqual(parseDictation(undefined), { kind: 'absent' })
})

test('a minimal block gets its defaults', () => {
  const parsed = parseDictation({ apiKeyFile: '/home/me/.factotum/groq-api-key' })
  assert.deepEqual(parsed, {
    kind: 'ok',
    config: { apiKeyFile: '/home/me/.factotum/groq-api-key', model: DEFAULT_MODEL, vocabulary: [] },
  })
})

test('a full block is kept as written, with the terms trimmed', () => {
  const parsed = parseDictation({ apiKeyFile: '/k', model: 'whisper-large-v3', language: 'es', vocabulary: [' Muguerza ', 'Médica Sur'] })
  assert.deepEqual(parsed, {
    kind: 'ok',
    config: { apiKeyFile: '/k', model: 'whisper-large-v3', language: 'es', vocabulary: ['Muguerza', 'Médica Sur'] },
  })
})

test('each field that is wrong turns dictation off with a reason that names it', () => {
  const cases: readonly [unknown, string][] = [
    [{}, 'apiKeyFile'],
    [{ apiKeyFile: 42 }, 'apiKeyFile'],
    [{ apiKeyFile: 'relative/key' }, 'apiKeyFile'],
    [{ apiKeyFile: '/k', model: '' }, 'model'],
    [{ apiKeyFile: '/k', language: 'spanish' }, 'language'],
    [{ apiKeyFile: '/k', vocabulary: 'Muguerza' }, 'vocabulary'],
    [{ apiKeyFile: '/k', vocabulary: [''] }, 'vocabulary'],
    [{ apiKeyFile: '/k', vocabulary: ['x'.repeat(MAX_TERM_CHARS + 1)] }, 'vocabulary'],
    ['not an object', 'dictation'],
  ]
  for (const [raw, field] of cases) {
    const parsed = parseDictation(raw)
    assert.equal(parsed.kind, 'invalid', JSON.stringify(raw))
    if (parsed.kind === 'invalid') assert.match(parsed.reason, new RegExp(field), JSON.stringify(raw))
  }
})

test('a misspelt key switches dictation off and says which: it is not lost in silence (criterion 4)', () => {
  const parsed = parseDictation({ apiKeyFile: '/k', vocabularly: ['Muguerza'] })
  assert.equal(parsed.kind, 'invalid')
  if (parsed.kind === 'invalid') assert.match(parsed.reason, /vocabularly/)
})

test('one term too many is refused rather than cut', () => {
  const vocabulary = Array.from({ length: MAX_TERMS + 1 }, (_, i) => `t${i}`)
  assert.equal(parseDictation({ apiKeyFile: '/k', vocabulary }).kind, 'invalid')
  assert.equal(parseDictation({ apiKeyFile: '/k', vocabulary: vocabulary.slice(1) }).kind, 'ok')
})

test('the reason never carries the value: a key pasted where its path goes stays out of the log (criterion 18)', () => {
  const parsed = parseDictation({ apiKeyFile: 'gsk_CENTINELA_secret' })
  assert.equal(parsed.kind, 'invalid')
  if (parsed.kind === 'invalid') assert.doesNotMatch(parsed.reason, /CENTINELA/)
  const unknown = parseDictation({ apiKeyFile: '/k', apiKey: 'gsk_CENTINELA_secret' })
  assert.equal(unknown.kind, 'invalid')
  if (unknown.kind === 'invalid') assert.doesNotMatch(unknown.reason, /CENTINELA/)
})
