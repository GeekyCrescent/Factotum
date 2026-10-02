import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ATTRIBUTED_TOOLS, createCallers } from './callers.ts'
import { QUALIFIED_TOOL } from './questions/mcp.ts'
import { QUALIFIED_START } from './services/shape.ts'

const note = (toolName: string, toolUseId: unknown, agentId: string | undefined, sessionId = 'a') => ({ toolName, toolUseId, agentId, sessionId })

test('ask_owner and start_service are attributed; nothing else is', () => {
  assert.deepEqual([...ATTRIBUTED_TOOLS].sort(), [QUALIFIED_TOOL, QUALIFIED_START].sort())
})

test('a subagent noted for a tool_use_id is taken once, by the same session', () => {
  const callers = createCallers()
  callers.note(note(QUALIFIED_START, 'tu1', 'agent-1'))
  assert.equal(callers.take('tu1', 'a'), 'agent-1')
  assert.equal(callers.take('tu1', 'a'), undefined, 'read and deleted')
})

test('take from ANOTHER session is undefined, and the note is gone anyway', () => {
  const callers = createCallers()
  callers.note(note(QUALIFIED_TOOL, 'tu1', 'agent-1', 'a'))
  assert.equal(callers.take('tu1', 'b'), undefined)
  assert.equal(callers.take('tu1', 'a'), undefined)
})

test('only attributed tools with a subagent and a string id are noted', () => {
  const callers = createCallers()
  callers.note(note('Bash', 'tu1', 'agent-1'))
  callers.note(note(QUALIFIED_START, 'tu2', undefined))
  callers.note(note(QUALIFIED_START, 42, 'agent-1'))
  assert.deepEqual([callers.take('tu1', 'a'), callers.take('tu2', 'a'), callers.take(undefined, 'a')], [undefined, undefined, undefined])
})

test('forgetSession drops one session, clear drops all', () => {
  const callers = createCallers()
  callers.note(note(QUALIFIED_START, 'tu1', 'x', 'a'))
  callers.note(note(QUALIFIED_START, 'tu2', 'y', 'b'))
  callers.forgetSession('a')
  assert.equal(callers.take('tu1', 'a'), undefined)
  assert.equal(callers.take('tu2', 'b'), 'y')
  callers.note(note(QUALIFIED_TOOL, 'tu3', 'z', 'b'))
  callers.clear()
  assert.equal(callers.take('tu3', 'b'), undefined)
})
