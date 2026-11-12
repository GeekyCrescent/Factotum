import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fail, isManualChannel, ok } from './types.ts'

test('ok and fail build the two arms of a Result', () => {
  assert.deepEqual(ok(1), { ok: true, value: 1 })
  assert.deepEqual(fail('conflict', 'busy'), { ok: false, error: { code: 'conflict', reason: 'busy' } })
  assert.deepEqual(fail('invalid', 'too long', 'text'), { ok: false, error: { code: 'invalid', reason: 'too long', field: 'text' } })
})

test('every channel but email is manual (v4, B1)', () => {
  assert.equal(isManualChannel('email'), false)
  for (const channel of ['form', 'platform', 'linkedin'] as const) assert.equal(isManualChannel(channel), true)
})
