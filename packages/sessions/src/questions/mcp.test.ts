import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CANCELLED_TEXT,
  EXPIRED_TEXT,
  handleMcp,
  NOT_RUNNING,
  QUALIFIED_TOOL,
  resultFor,
  SHUTDOWN_TEXT,
  toolText,
  UNREACHABLE,
  type McpDeps,
  type McpTool,
  type ToolResult,
} from './mcp.ts'
import { MAX_OPTIONS, MAX_QUESTIONS, type Question } from './shape.ts'

const ok: ToolResult = toolText('fine', false)

/** No services: the questions' tests see exactly the server they always saw. */
const NO_SERVICES: McpDeps['services'] = {
  tools: [],
  call: async () => {
    throw new Error('no service tool should be called here')
  },
}

function deps(answer: ToolResult = ok) {
  const calls: { sessionId: string; toolUseId: string | undefined; raw: unknown }[] = []
  const d: McpDeps = {
    askOwner: async (input) => {
      calls.push(input)
      return answer
    },
    services: NO_SERVICES,
  }
  return { d, calls }
}

const call = (args: unknown, extra: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name: 'ask_owner', arguments: args, ...extra },
})

function bodyOf(reply: Awaited<ReturnType<typeof handleMcp>>): Record<string, unknown> {
  assert.equal(reply.kind, 'body')
  return (reply as { body: Record<string, unknown> }).body
}

// ---------------------------------------------------------------------------
// The protocol (criterion 5)
// ---------------------------------------------------------------------------

test('the qualified name is what the agent sees', () => {
  assert.equal(QUALIFIED_TOOL, 'mcp__factotum__ask_owner')
})

test('initialize echoes the protocol version and declares tools', async () => {
  const body = bodyOf(await handleMcp(deps().d, 's', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }))
  assert.equal(body.jsonrpc, '2.0')
  assert.equal(body.id, 1)
  const result = body.result as { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } }
  assert.equal(result.protocolVersion, '2025-11-25')
  assert.deepEqual(result.capabilities.tools, {})
  assert.equal(result.serverInfo.name, 'factotum')
})

test('tools/list gives the one tool, with the limits in its schema and when to use it', async () => {
  const body = bodyOf(await handleMcp(deps().d, 's', { jsonrpc: '2.0', id: 'a', method: 'tools/list' }))
  const tools = (body.result as { tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] }).tools
  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.name, 'ask_owner')
  assert.match(tools[0]?.description ?? '', /instead of asking in plain text/)
  assert.match(tools[0]?.description ?? '', /"unanswered": true/)
  const questions = (tools[0]?.inputSchema.properties as Record<string, { maxItems: number; minItems: number; items: { properties: { options: { maxItems: number; minItems: number } } } }>).questions
  assert.equal(questions?.maxItems, MAX_QUESTIONS)
  assert.equal(questions?.minItems, 1)
  assert.equal(questions?.items.properties.options.maxItems, MAX_OPTIONS)
  assert.equal(questions?.items.properties.options.minItems, 2)
})

test('a notification (no id) is accepted with nothing to say', async () => {
  assert.deepEqual(await handleMcp(deps().d, 's', { jsonrpc: '2.0', method: 'notifications/initialized' }), { kind: 'accepted' })
  assert.deepEqual(await handleMcp(deps().d, 's', { jsonrpc: '2.0', id: null, method: 'tools/call' }), { kind: 'accepted' })
})

test('an unknown method is -32601, server/discover included', async () => {
  for (const method of ['server/discover', 'resources/list', 'nope']) {
    const body = bodyOf(await handleMcp(deps().d, 's', { jsonrpc: '2.0', id: 3, method }))
    assert.equal((body.error as { code: number }).code, -32601, method)
  }
})

test('calling another tool is -32602, and asks nobody', async () => {
  const { d, calls } = deps()
  const body = bodyOf(await handleMcp(d, 's', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'other', arguments: {} } }))
  assert.equal((body.error as { code: number }).code, -32602)
  assert.equal(calls.length, 0)
})

test('something that is not a message at all is answered as an invalid request, not thrown', async () => {
  for (const message of [null, 'x', 42, [{ id: 1 }]]) {
    const body = bodyOf(await handleMcp(deps().d, 's', message))
    assert.equal((body.error as { code: number }).code, -32600)
    assert.equal(body.id, null)
  }
})

// ---------------------------------------------------------------------------
// tools/call reaches askOwner with the session, the arguments and the toolUseId (§0.3)
// ---------------------------------------------------------------------------

test('tools/call hands askOwner the session of the URL, the arguments and _meta toolUseId', async () => {
  const { d, calls } = deps()
  const body = bodyOf(await handleMcp(d, 'sess-1', call({ questions: [] }, { _meta: { 'claudecode/toolUseId': 'toolu_1', progressToken: 2 } })))
  assert.deepEqual(calls, [{ sessionId: 'sess-1', toolUseId: 'toolu_1', raw: { questions: [] } }])
  assert.deepEqual(body.result, ok)
  assert.equal(body.id, 7)
})

test('a toolUseId that is not text is undefined', async () => {
  const { d, calls } = deps()
  await handleMcp(d, 's', call({}, { _meta: { 'claudecode/toolUseId': 5 } }))
  await handleMcp(d, 's', call({}))
  assert.deepEqual(calls.map((c) => c.toolUseId), [undefined, undefined])
})

test('askOwner throwing becomes an isError result the agent can read, never a thrown error', async () => {
  const d: McpDeps = {
    askOwner: async () => {
      throw new Error('disk full')
    },
    services: NO_SERVICES,
  }
  const body = bodyOf(await handleMcp(d, 's', call({})))
  const result = body.result as ToolResult
  assert.equal(result.isError, true)
  assert.match(result.content[0]?.text ?? '', /could not ask/)
})

// ---------------------------------------------------------------------------
// The services' tools arrive as DATA (spec 2026-10-02-servicios-en-segundo-plano, D7; criterion 4)
// ---------------------------------------------------------------------------

const SERVICE_TOOL: McpTool = { name: 'start_service', description: 'start one', inputSchema: { type: 'object' } }

function withServices(answer: ToolResult = ok) {
  const calls: { sessionId: string; toolUseId: string | undefined; name: string; raw: unknown }[] = []
  const asked: unknown[] = []
  const d: McpDeps = {
    askOwner: async (input) => (asked.push(input), ok),
    services: {
      tools: [SERVICE_TOOL, { ...SERVICE_TOOL, name: 'service_output' }],
      call: async (input) => (calls.push(input), answer),
    },
  }
  return { d, calls, asked }
}

test('tools/list gives ask_owner FIRST and then every service tool, as handed', async () => {
  const body = bodyOf(await handleMcp(withServices().d, 's', { jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  const tools = (body.result as { tools: McpTool[] }).tools
  assert.deepEqual(
    tools.map((t) => t.name),
    ['ask_owner', 'start_service', 'service_output'],
  )
  assert.deepEqual(tools[1], SERVICE_TOOL)
})

test('tools/call of a service tool goes to services.call with the session, the name, the args and the toolUseId', async () => {
  const { d, calls, asked } = withServices()
  const body = bodyOf(
    await handleMcp(d, 'sess-1', { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'service_output', arguments: { id: 's1' }, _meta: { 'claudecode/toolUseId': 'tu9' } } }),
  )
  assert.deepEqual(calls, [{ sessionId: 'sess-1', toolUseId: 'tu9', name: 'service_output', raw: { id: 's1' } }])
  assert.equal(asked.length, 0)
  assert.deepEqual(body.result, ok)
})

test('a service tool throwing is an isError result that does not talk about asking', async () => {
  const d: McpDeps = {
    askOwner: async () => ok,
    services: {
      tools: [SERVICE_TOOL],
      call: async () => {
        throw new Error('EIO')
      },
    },
  }
  const result = bodyOf(await handleMcp(d, 's', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'start_service', arguments: {} } })).result as ToolResult
  assert.equal(result.isError, true)
  assert.match(result.content[0]?.text ?? '', /could not run start_service \(EIO\)/)
  assert.doesNotMatch(result.content[0]?.text ?? '', /ask/)
})

test('a name that is in neither list is still -32602', async () => {
  const { d, calls } = withServices()
  const body = bodyOf(await handleMcp(d, 's', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'stop_everything', arguments: {} } }))
  assert.equal((body.error as { code: number }).code, -32602)
  assert.equal(calls.length, 0)
})

// ---------------------------------------------------------------------------
// What the agent receives (criteria 9, 11, 12, design D3)
// ---------------------------------------------------------------------------

const batch: readonly Question[] = [
  { id: 'q1', text: 'Which colour?', options: [{ id: 'r', label: 'red' }, { id: 'g', label: 'green' }], multiple: false },
  { id: 'q2', text: 'Which sizes?', options: [{ id: 's', label: 'S' }, { id: 'm', label: 'M' }, { id: 'l', label: 'L' }], multiple: true },
  { id: 'q3', text: 'A name?', options: [{ id: 'a', label: 'Ada' }, { id: 'b', label: 'Bob' }], multiple: false },
  { id: 'q4', text: 'Deploy?', options: [{ id: 'y', label: 'yes' }, { id: 'n', label: 'no' }], multiple: false },
]

test('an answer comes back as labels, in the order of the batch, with unanswered: true for the gaps', () => {
  const result = resultFor(
    {
      kind: 'answered',
      answers: [
        { question: 'q1', kind: 'chosen', options: ['g'] },
        { question: 'q2', kind: 'chosen', options: ['s', 'l'] },
        { question: 'q3', kind: 'none' },
        { question: 'q4', kind: 'text', text: 'only on Friday' },
      ],
      via: 'token',
    },
    batch,
  )
  assert.equal(result.isError, undefined)
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ''), {
    answers: [
      { question: 'Which colour?', chosen: ['green'] },
      { question: 'Which sizes?', chosen: ['S', 'L'] },
      { question: 'A name?', unanswered: true },
      { question: 'Deploy?', text: 'only on Friday' },
    ],
  })
})

test('every entry carries exactly one of chosen, text or unanswered, and chosen is always a list', () => {
  const result = resultFor(
    {
      kind: 'answered',
      answers: [
        { question: 'q1', kind: 'chosen', options: ['r'] },
        { question: 'q2', kind: 'none' },
        { question: 'q3', kind: 'text', text: 'Cy' },
        { question: 'q4', kind: 'none' },
      ],
      via: 'screen',
    },
    batch,
  )
  const answers = (JSON.parse(result.content[0]?.text ?? '') as { answers: Record<string, unknown>[] }).answers
  for (const entry of answers) {
    const keys = Object.keys(entry).filter((k) => k !== 'question')
    assert.equal(keys.length, 1, JSON.stringify(entry))
    if ('chosen' in entry) assert.equal(Array.isArray(entry.chosen), true)
    if ('text' in entry) assert.equal(typeof entry.text, 'string')
    if ('unanswered' in entry) assert.equal(entry.unanswered, true)
  }
})

test('expired, cancelled and shutdown are errors that say there is no decision', () => {
  const rows: [Parameters<typeof resultFor>[0], string][] = [
    [{ kind: 'expired' }, EXPIRED_TEXT],
    [{ kind: 'cancelled' }, CANCELLED_TEXT],
    [{ kind: 'shutdown', reason: 'x' }, SHUTDOWN_TEXT],
  ]
  for (const [outcome, text] of rows) {
    const result = resultFor(outcome, batch)
    assert.equal(result.isError, true)
    assert.equal(result.content[0]?.text, text)
    assert.match(text, /no decision/i)
  }
  assert.match(EXPIRED_TEXT, /end your turn now/)
})

test('the texts for no push and a session not running are exported constants', () => {
  assert.equal(UNREACHABLE, 'The owner cannot be reached right now; ask in plain text instead.')
  assert.equal(NOT_RUNNING, 'This session is not running in factotum.')
  assert.deepEqual(toolText(UNREACHABLE, true), { content: [{ type: 'text', text: UNREACHABLE }], isError: true })
  assert.equal('isError' in toolText('x', false), false)
})
