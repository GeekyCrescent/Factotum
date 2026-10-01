import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentOf, preToolUsePayloadSchema, type PreToolUsePayload } from './payload.ts'

const base = {
  hook_event_name: 'PreToolUse',
  session_id: 's1',
  tool_name: 'Write',
  tool_input: { file_path: '/a' },
  tool_use_id: 'toolu_1',
  cwd: '/work',
}

function parsed(extra: Record<string, unknown>): PreToolUsePayload {
  const result = preToolUsePayloadSchema.safeParse({ ...base, ...extra })
  if (!result.success) throw new Error(`the payload no longer validates: ${result.error.message}`)
  return result.data
}

test("a subagent's call names its agent (spec 2026-10-01-subagentes, criterion 32)", () => {
  assert.equal(agentOf(parsed({ agent_id: 'ae1db41bef7fa4796', agent_type: 'general-purpose' })), 'ae1db41bef7fa4796')
})

test("the main agent's call names nobody", () => {
  assert.equal(agentOf(parsed({})), undefined)
})

test('an agent_id that is not a non-empty string is no agent, and does not invalidate the payload', () => {
  assert.equal(agentOf(parsed({ agent_id: 7 })), undefined)
  assert.equal(agentOf(parsed({ agent_id: '' })), undefined)
  assert.equal(agentOf(parsed({ agent_id: null })), undefined)
})
