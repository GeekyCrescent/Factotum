import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionsConfigSchema } from './config.ts'

test('the dictation block passes through WHOLE, uninterpreted, whatever it holds (spec 2026-10-03, D3)', () => {
  const block = { apiKeyFile: 42, vocabularly: ['typo'], anything: { nested: true } }
  const parsed = sessionsConfigSchema.safeParse({ dictation: block })
  assert.equal(parsed.success, true)
  if (parsed.success) assert.deepEqual(parsed.data.dictation, block)
})

test('models: absent is none, a list of label and model passes, a name the CLI could misread is refused', () => {
  assert.deepEqual(sessionsConfigSchema.parse({}).models, [])
  const models = [
    { label: 'Opus', model: 'opus[1m]' },
    { label: 'Fable', model: 'fable' },
  ]
  assert.deepEqual(sessionsConfigSchema.parse({ models }).models, models)
  for (const model of ['', '-x', 'Opus', 'a b']) {
    assert.equal(sessionsConfigSchema.safeParse({ models: [{ label: 'X', model }] }).success, false, model)
  }
  assert.equal(sessionsConfigSchema.safeParse({ models: [{ label: '', model: 'fable' }] }).success, false)
  // Two entries for one model would be two options that do the same thing.
  assert.equal(sessionsConfigSchema.safeParse({ models: [...models, { label: 'Again', model: 'fable' }] }).success, false)
})

test('a fragment without dictation parses as it always did', () => {
  const parsed = sessionsConfigSchema.safeParse({})
  assert.equal(parsed.success, true)
  if (parsed.success) {
    assert.equal(parsed.data.dictation, undefined)
    assert.deepEqual(parsed.data.sites, [])
  }
})
