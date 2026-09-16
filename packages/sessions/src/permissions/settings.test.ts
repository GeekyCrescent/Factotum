import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ASK_ANSWER_MARGIN_SECONDS, ASK_TIMEOUT_SECONDS, HOOK_TIMEOUT_SECONDS, hookSettings } from './settings.ts'

test('factotum gives up on an ask STRICTLY BEFORE the CLI does (criterion 18)', () => {
  // Measured (spec §0.32): when the CLI's own timeout fires first, the agent is told a generic
  // "you haven't granted it yet". The margin is what lets the log say instead that nobody answered.
  assert.ok(ASK_TIMEOUT_SECONDS < HOOK_TIMEOUT_SECONDS)
  assert.ok(ASK_ANSWER_MARGIN_SECONDS > 0, 'a negative margin would compile')
  assert.equal(ASK_TIMEOUT_SECONDS, HOOK_TIMEOUT_SECONDS - ASK_ANSWER_MARGIN_SECONDS)
})

test('the ask window is the owner’s hour, and no longer than what the CLI was measured to wait', () => {
  assert.equal(HOOK_TIMEOUT_SECONDS, 3600)
})

test('the settings file carries that timeout to the CLI', () => {
  const hook = hookSettings('http://127.0.0.1:7877').hooks.PreToolUse[0]?.hooks[0]
  assert.equal(hook?.timeout, HOOK_TIMEOUT_SECONDS)
})
