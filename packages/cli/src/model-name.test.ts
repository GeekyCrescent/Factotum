import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_NAME as ENGINE_MODEL_NAME } from '@factotum/sessions'
import { MODEL_NAME } from '@factotum/modules'

/**
 * The model rule exists twice for the reason the name rule does (`invokable-name.test.ts`): `modules/`
 * cannot import `packages/sessions` (CLAUDE.md §1). The module checks a launch with it; the engine checks
 * every `meta.json` it reads, the ones a handoff brings from the other host included.
 */

const GOOD = ['fable', 'opus', 'opus[1m]', 'claude-fable-5-1', 'claude-opus-5-5[1m]', 'sonnet.x']
const BAD = ['', '-x', '--model', 'Opus', 'a b', 'x\ny', '[1m]']

test('the two copies of the model rule have the same source', () => {
  assert.equal(MODEL_NAME.source, ENGINE_MODEL_NAME.source)
  assert.equal(MODEL_NAME.flags, ENGINE_MODEL_NAME.flags)
})

test('the two copies accept and refuse the same models', () => {
  for (const name of GOOD) {
    assert.equal(ENGINE_MODEL_NAME.test(name), true, name)
    assert.equal(MODEL_NAME.test(name), true, name)
  }
  for (const name of BAD) {
    assert.equal(ENGINE_MODEL_NAME.test(name), false, JSON.stringify(name))
    assert.equal(MODEL_NAME.test(name), false, JSON.stringify(name))
  }
})
