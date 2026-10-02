import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCallers } from '../callers.ts'
import { NOT_RUNNING, type ToolResult } from '../questions/mcp.ts'
import type { Site } from '../sites.ts'
import { MAX_COMMAND_CHARS, MAX_LINES, MAX_MAX_MINUTES, QUALIFIED_START, type ServiceView, type StartRequest } from './shape.ts'
import type { ServiceTable, StartOutcome } from './table.ts'
import { createServiceTools, SERVICE_TOOLS } from './tools.ts'

const SITE: Site = { id: 'work', path: '/work/repo', realPath: '/work/repo', isRepo: true }
const SESSION = 'sess-a'

const view = (over: Partial<ServiceView> = {}): ServiceView => ({
  id: 's1',
  command: 'python3 -m http.server 8765',
  description: undefined,
  cwd: '/work/repo',
  pid: 4242,
  maxMinutes: 480,
  startedAt: '2026-10-02T12:00:00.000Z',
  task: undefined,
  state: 'running',
  endedAt: undefined,
  by: undefined,
  code: undefined,
  signal: undefined,
  reason: undefined,
  ...over,
})

interface Calls {
  start: { sessionId: string; request: StartRequest; task: string | undefined }[]
  read: unknown[][]
  stop: unknown[][]
  list: string[]
}

function world(over: { start?: StartOutcome; read?: { view: ServiceView; lines: readonly string[] }; stop?: ServiceView; list?: readonly ServiceView[]; live?: boolean } = {}) {
  const calls: Calls = { start: [], read: [], stop: [], list: [] }
  const table: ServiceTable = {
    start: async (sessionId, request, task) => (calls.start.push({ sessionId, request, task }), over.start ?? { kind: 'started', view: view() }),
    read: async (...args) => (calls.read.push(args), over.read),
    stop: async (...args) => (calls.stop.push(args), over.stop),
    list: async (sessionId) => (calls.list.push(sessionId), over.list ?? []),
    stopSession: async () => undefined,
    reopen: () => undefined,
    pending: async () => undefined,
    stopAll: async () => undefined,
  }
  const callers = createCallers()
  const call = createServiceTools({ services: table, callers, liveSite: (id) => (over.live === false || id !== SESSION ? undefined : SITE) })
  const run = async (name: string, raw: unknown, toolUseId?: string): Promise<ToolResult> => await call({ sessionId: SESSION, toolUseId, name, raw })
  return { calls, callers, call, run }
}

const text = (result: ToolResult): string => result.content.map((c) => c.text).join('\n')

// --- the list (criterion 4) -------------------------------------------------------

test('four tools, with their limits in the schema', () => {
  assert.deepEqual(
    SERVICE_TOOLS.map((t) => t.name),
    ['start_service', 'service_output', 'stop_service', 'list_services'],
  )
  const start = SERVICE_TOOLS[0]?.inputSchema as { properties: Record<string, Record<string, unknown>>; required: string[] }
  assert.equal(start.properties.command?.maxLength, MAX_COMMAND_CHARS)
  assert.equal(start.properties.max_minutes?.maximum, MAX_MAX_MINUTES)
  assert.deepEqual(start.required, ['command'])
  const output = SERVICE_TOOLS[1]?.inputSchema as { properties: Record<string, Record<string, unknown>> }
  assert.equal(output.properties.lines?.maximum, MAX_LINES)
  // What the agent reads before calling: that it survives, the default, how to read it (measured in A3).
  assert.match(SERVICE_TOOLS[0]?.description ?? '', /keep running after your turn ends/)
  assert.match(SERVICE_TOOLS[0]?.description ?? '', /480/)
  assert.match(SERVICE_TOOLS[0]?.description ?? '', /service_output/)
})

// --- only inside a turn (criterion 40) ---------------------------------------------

test('without a live turn every tool answers NOT_RUNNING and touches nothing', async () => {
  const { run, calls } = world({ live: false })
  for (const [name, raw] of [['start_service', { command: 'x' }], ['service_output', { id: 's1' }], ['stop_service', { id: 's1' }], ['list_services', {}]] as const) {
    const result = await run(name, raw)
    assert.equal(result.isError, true)
    assert.equal(text(result), NOT_RUNNING)
  }
  assert.deepEqual([calls.start.length, calls.read.length, calls.stop.length, calls.list.length], [0, 0, 0, 0])
})

// --- start_service (criteria 5, 6, 7, 15) ---------------------------------------------

test('start: the cwd is resolved against the site and the id and pid come back, not an error', async () => {
  const { run, calls } = world()
  const result = await run('start_service', { command: 'pnpm dev', cwd: 'apps/web', max_minutes: 30 })
  assert.equal(result.isError, undefined)
  assert.match(text(result), /s1/)
  assert.match(text(result), /4242/)
  assert.deepEqual(calls.start[0]?.request, { command: 'pnpm dev', description: undefined, cwd: '/work/repo/apps/web', maxMinutes: 30 })
})

test('start: invalid input is an error that says what to fix, and nothing is started', async () => {
  const { run, calls } = world()
  const result = await run('start_service', { command: '' })
  assert.equal(result.isError, true)
  assert.match(text(result), /command/)
  assert.equal(calls.start.length, 0)
})

test('start: a subagent noted by the gate becomes the task (criterion 15)', async () => {
  const { run, calls, callers } = world()
  callers.note({ toolName: QUALIFIED_START, toolUseId: 'tu1', agentId: 'agent-7', sessionId: SESSION })
  await run('start_service', { command: 'x' }, 'tu1')
  await run('start_service', { command: 'x' }, 'tu2')
  assert.deepEqual(
    calls.start.map((c) => c.task),
    ['agent-7', undefined],
  )
})

test('start: a command that exited during startup is an error with its code and its last lines (criterion 6)', async () => {
  const { run } = world({ start: { kind: 'exited-early', view: view({ state: 'failed', code: 1 }), lines: ['OSError: Address already in use'] } })
  const result = await run('start_service', { command: 'python3 -m http.server 80' })
  assert.equal(result.isError, true)
  assert.match(text(result), /code 1/)
  assert.match(text(result), /Address already in use/)
})

test('start: a refusal from the table is an error with its reason', async () => {
  const { run } = world({ start: { kind: 'refused', reason: 'The session was cancelled.' } })
  const result = await run('start_service', { command: 'x' })
  assert.equal(result.isError, true)
  assert.equal(text(result), 'The session was cancelled.')
})

// --- service_output, stop_service, list_services (criteria 8-11) ----------------------------

test('output: state and lines; the lines asked for reach the table; an unknown id is "no service"', async () => {
  const { run, calls } = world({ read: { view: view(), lines: ['GET / 200', 'GET /x 404'] } })
  const result = await run('service_output', { id: 's1', lines: 2 })
  assert.equal(result.isError, undefined)
  assert.match(text(result), /running/)
  assert.match(text(result), /GET \/ 200\nGET \/x 404/)
  assert.deepEqual(calls.read[0], [SESSION, 's1', 2])

  const missing = await world().run('service_output', { id: 's9' })
  assert.equal(missing.isError, true)
  assert.match(text(missing), /no service s9 in this session/)
})

test('output of a service with nothing written says so', async () => {
  const { run } = world({ read: { view: view(), lines: [] } })
  assert.match(text(await run('service_output', { id: 's1' })), /no output yet/)
})

test('stop: the agent stops it and gets the final state; an unknown id is "no service"', async () => {
  const { run, calls } = world({ stop: view({ state: 'stopped', by: 'agent', endedAt: 't' }) })
  const result = await run('stop_service', { id: 's1' })
  assert.equal(result.isError, undefined)
  assert.match(text(result), /stopped/)
  assert.deepEqual(calls.stop[0], [SESSION, 's1', 'agent'])
  assert.equal((await world().run('stop_service', { id: 's1' })).isError, true)
  assert.equal((await world().run('stop_service', {})).isError, true)
})

test('list: one line per service with id, command, state and since when; or none', async () => {
  const { run } = world({ list: [view(), view({ id: 's2', state: 'failed', code: 1, command: 'pnpm dev', endedAt: '2026-10-02T12:05:00.000Z' })] })
  const listed = text(await run('list_services', {}))
  assert.match(listed, /s1 · running since 2026-10-02T12:00:00.000Z · python3 -m http.server 8765/)
  assert.match(listed, /s2 · failed \(code 1\)/)
  assert.match(text(await world().run('list_services', {})), /No services/)
})

test('each ending reads as words the agent can act on', async () => {
  const cases: [Partial<ServiceView>, RegExp][] = [
    [{ state: 'exited', code: 0 }, /exited \(code 0\)/],
    [{ state: 'failed', signal: 'SIGSEGV' }, /failed \(SIGSEGV\)/],
    [{ state: 'stopped', by: 'owner' }, /stopped by the owner/],
    [{ state: 'timeout' }, /stopped after 480 minutes/],
    [{ state: 'cancelled' }, /session was cancelled/],
    [{ state: 'shutdown', reason: 'factotum restarted' }, /factotum restarted/],
  ]
  for (const [over, expected] of cases) {
    const { run } = world({ read: { view: view(over), lines: [] } })
    assert.match(text(await run('service_output', { id: 's1' })), expected)
  }
})

test('an unknown name is an error, not a throw', async () => {
  const result = await world().run('restart_service', {})
  assert.equal(result.isError, true)
})
