import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionsConfigSchema } from './config.ts'

test('the dictation block passes through WHOLE, uninterpreted, whatever it holds (spec 2026-10-03, D3)', () => {
  const block = { apiKeyFile: 42, vocabularly: ['typo'], anything: { nested: true } }
  const parsed = sessionsConfigSchema.safeParse({ dictation: block })
  assert.equal(parsed.success, true)
  if (parsed.success) assert.deepEqual(parsed.data.dictation, block)
})

test('a fragment without dictation parses as it always did', () => {
  const parsed = sessionsConfigSchema.safeParse({})
  assert.equal(parsed.success, true)
  if (parsed.success) {
    assert.equal(parsed.data.dictation, undefined)
    assert.deepEqual(parsed.data.sites, [])
  }
})
