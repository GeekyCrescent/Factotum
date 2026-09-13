import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ERROR_CODES, errorBody, MAX_BODY_BYTES } from './http.ts'

test('builds an error envelope with a code from the closed list', () => {
  assert.deepEqual(errorBody('unknown-origin', 'origin http://evil.com is not this host'), {
    error: { code: 'unknown-origin', message: 'origin http://evil.com is not this host' },
  })
})

test('the error codes are unique', () => {
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length)
})

test('the body cap is a megabyte', () => {
  assert.equal(MAX_BODY_BYTES, 1_048_576)
})
