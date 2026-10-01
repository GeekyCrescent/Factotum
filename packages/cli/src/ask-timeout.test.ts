import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ASK_TIMEOUT_SECONDS } from '@factotum/sessions'
import { askTimeoutFrom } from './ask-timeout.ts'

function run(env: string, value: string | undefined) {
  const warnings: string[] = []
  const deps = askTimeoutFrom(env, { FACTOTUM_ASK_TIMEOUT_SECONDS: value }, (m) => warnings.push(m))
  return { deps, warnings }
}

test('in dev, the variable shortens the window, in milliseconds', () => {
  const { deps, warnings } = run('dev', '60')
  assert.deepEqual(deps, { askTimeoutMs: 60_000 })
  assert.deepEqual(warnings, [])
})

test('without the variable there is nothing, not even an undefined key', () => {
  const { deps, warnings } = run('dev', undefined)
  assert.deepEqual(deps, {})
  assert.equal('askTimeoutMs' in deps, false)
  assert.deepEqual(warnings, [])
})

test('in prod it is ignored, and said only when it is set', () => {
  const set = run('prod', '60')
  assert.deepEqual(set.deps, {})
  assert.equal(set.warnings.length, 1)
  assert.match(set.warnings[0] ?? '', /FACTOTUM_ASK_TIMEOUT_SECONDS/)
  const unset = run('prod', undefined)
  assert.deepEqual(unset.deps, {})
  assert.deepEqual(unset.warnings, [])
})

test('outside 30…ASK_TIMEOUT_SECONDS, or not an integer, it is ignored with a warning', () => {
  for (const value of ['29', String(ASK_TIMEOUT_SECONDS + 1), 'abc', '60.5', '', '-60']) {
    const { deps, warnings } = run('dev', value)
    assert.deepEqual(deps, {}, value)
    assert.equal(warnings.length, 1, value)
  }
})

test('the two ends of the range are accepted', () => {
  assert.deepEqual(run('dev', '30').deps, { askTimeoutMs: 30_000 })
  assert.deepEqual(run('dev', String(ASK_TIMEOUT_SECONDS)).deps, { askTimeoutMs: ASK_TIMEOUT_SECONDS * 1000 })
})
