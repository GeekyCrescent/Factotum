import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ENVIRONMENT, ENVIRONMENTS, isEnvironment } from './env.ts'

test('there are exactly two environments and prod is the default', () => {
  assert.deepEqual([...ENVIRONMENTS], ['dev', 'prod'])
  assert.equal(DEFAULT_ENVIRONMENT, 'prod')
})

test('recognises the two environments and nothing else', () => {
  assert.equal(isEnvironment('dev'), true)
  assert.equal(isEnvironment('prod'), true)
  assert.equal(isEnvironment('staging'), false)
  assert.equal(isEnvironment(undefined), false)
})
