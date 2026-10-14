import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModuleContext, ModuleRequest, ModuleResponse, RouteTable } from '@factotum/core'
import { tasksConfigSchema } from './config.ts'
import { tasksModule } from './server.ts'
import type { AgentToolImpl, BoardView, ClosedCycle, CreateTasks, Result, Task, Tasks, TasksLink, TasksSetup } from './types.ts'

const CARD: Task = {
  id: 'c1',
  title: 'card',
  notes: '',
  status: 'todo',
  order: 'V',
  cycle: '2026-W42',
  area: null,
  project: null,
  priority: 0,
  labels: [],
  estimate: null,
  due: null,
  remindAt: null,
  remindedAt: null,
  reminderMissed: false,
  subtasks: [],
  source: { kind: 'owner' },
  sessions: [],
  createdAt: 'a',
  updatedAt: 'a',
  completedAt: null,
}

const VIEW: BoardView = {
  timeZone: 'Australia/Sydney',
  openCycle: '2026-W42',
  openRange: { start: '2026-10-12', end: '2026-10-18' },
  currentCycle: '2026-W42',
  needsClose: false,
  tasks: [CARD],
  triage: 0,
  areas: [],
  labels: [],
  projects: [],
}

const CLOSED: ClosedCycle = { id: '2026-W41', closedAt: 'b', done: [], canceled: [], carried: [] }

const AGENT: AgentToolImpl = { tools: () => [{ name: 'create_task', description: 'd', inputSchema: {} }], call: async () => ({ content: [] }) }

interface Calls {
  readonly log: string[]
}

function fakeTasks(calls: Calls, over: Partial<Tasks> = {}): Tasks {
  const answer = (name: string, value: Result<Task>) => async (...args: unknown[]) => {
    calls.log.push(`${name} ${JSON.stringify(args)}`)
    return value
  }
  return {
    board: (filter) => {
      calls.log.push(`board ${JSON.stringify(filter ?? {})}`)
      return VIEW
    },
    get: (id) => (id === CARD.id ? CARD : undefined),
    create: answer('create', { ok: true, value: CARD }),
    patch: answer('patch', { ok: true, value: CARD }),
    move: answer('move', { ok: true, value: CARD }),
    accept: answer('accept', { ok: true, value: CARD }),
    remove: async (id) => ({ ok: true, value: { id } }),
    linkSession: answer('linkSession', { ok: true, value: CARD }),
    closeCycles: async () => ({ ok: true, value: [CLOSED] }),
    cycles: () => [{ id: CLOSED.id, range: { start: 'x', end: 'y' }, closedAt: 'b', done: 0, canceled: 0, carried: 0 }],
    cycle: (id) => (id === CLOSED.id ? CLOSED : undefined),
    triage: () => [{ ...CARD, status: 'triage', cycle: null, source: { kind: 'capture', raw: 'card', parse: 'pending' } }],
    capture: answer('capture', { ok: true, value: { ...CARD, status: 'triage', cycle: null } }),
    runNext: () => {
      calls.log.push('runNext')
      return { ok: true, value: { started: true } }
    },
    nextStatus: () => ({ running: false, last: { at: 'n', items: [{ id: 'c1', why: 'due' }], note: '' }, error: null }),
    agent: AGENT,
    where: () => ({ mode: 'board' }),
    fromPeer: async (raw) => {
      calls.log.push(`fromPeer ${JSON.stringify(raw)}`)
      return { content: [{ type: 'text', text: 'added' }] }
    },
    stop: async () => {
      calls.log.push('stop')
    },
    ...over,
  }
}

function recordingLink(events: string[]): TasksLink {
  let filled: AgentToolImpl | undefined
  return {
    family: { tools: () => filled?.tools() ?? [], call: async () => ({ content: [] }) },
    fill: (impl) => {
      events.push('fill')
      filled = impl
    },
    clear: () => {
      events.push('clear')
      filled = undefined
    },
  }
}

function context(errors: string[] = [], now = new Date('2026-10-13T23:00:00Z')): ModuleContext<unknown> {
  return {
    config: { timeZone: 'Australia/Sydney' },
    stateDir: '/tmp/never-written',
    env: 'dev',
    log: { info: () => undefined, warn: () => undefined, error: (message) => void errors.push(message) },
    now: () => now,
    timers: { setInterval: () => ({ [Symbol.dispose]: () => undefined }), setTimeout: () => ({ [Symbol.dispose]: () => undefined }) },
    notify: { canReach: () => false, send: async () => undefined },
    // No peers: `ctx.peers` answers every call `unreachable`, as the kernel does with an empty table.
    peers: {
      list: () => [],
      json: async () => ({ ok: false, status: undefined, reason: 'unreachable', body: undefined }) as const,
      upload: async () => ({ ok: false, status: undefined, reason: 'unreachable', body: undefined }) as const,
    },
  }
}

interface Started {
  readonly routes: RouteTable
  readonly setups: TasksSetup[]
  readonly calls: Calls
  readonly events: string[]
  readonly stop: () => Promise<void>
}

async function started(over: Partial<Tasks> = {}, options: { nowOffsetMs?: number } = {}): Promise<Started> {
  const setups: TasksSetup[] = []
  const calls: Calls = { log: [] }
  const events: string[] = []
  const create: CreateTasks = async (setup) => {
    setups.push(setup)
    events.push('created')
    return { ok: true, tasks: fakeTasks(calls, over) }
  }
  const module = tasksModule(create, recordingLink(events), options)
  const ctx = context()
  const routes = module.routes!(ctx)
  const handle = await module.start!(ctx)
  return { routes, setups, calls, events, stop: async () => await handle?.stop?.() }
}

function call(routes: RouteTable, key: string, req: Partial<ModuleRequest> = {}): Promise<ModuleResponse> {
  const handler = routes[key]
  if (handler === undefined) throw new Error(`no route ${key}`)
  return Promise.resolve(handler({ method: key.split(' ')[0]!, path: '/', params: {}, query: {}, body: undefined, ...req }))
}

function errorCode(response: ModuleResponse): string | undefined {
  return (response.body as { error?: { code?: string } } | undefined)?.error?.code
}

test('the module: id tasks, Tasks before Inbox in the nav, and its fragment carried unparsed', () => {
  const module = tasksModule(async () => ({ ok: false, reason: 'x' }), recordingLink([]))
  assert.equal(module.id, 'tasks')
  assert.deepEqual(module.nav, { label: 'Tasks', icon: 'kanban', order: 5 })
  const fragment = { anything: { at: 'all' } }
  assert.deepEqual(tasksConfigSchema.parse(fragment), fragment)
})

test('start hands over the raw fragment and the kernel’s state, log, timers and notifier, and fills the link LAST', async () => {
  const { setups, events } = await started()
  assert.equal(setups.length, 1)
  assert.deepEqual(setups[0]?.config, { timeZone: 'Australia/Sydney' })
  assert.equal(setups[0]?.stateDir, '/tmp/never-written')
  assert.equal(setups[0]?.now().toISOString(), '2026-10-13T23:00:00.000Z')
  assert.deepEqual(events, ['created', 'fill'])
})

test('the dev clock offset shifts the module’s now, and only that (S13)', async () => {
  const { setups } = await started({}, { nowOffsetMs: 7 * 24 * 60 * 60 * 1000 })
  assert.equal(setups[0]?.now().toISOString(), '2026-10-20T23:00:00.000Z')
})

test('stop clears the link first, then stops the board', async () => {
  const { stop, events, calls } = await started()
  await stop()
  assert.deepEqual(events, ['created', 'fill', 'clear'])
  assert.ok(calls.log.includes('stop'))
})

test('a factory that refuses: start throws with the reason, logs it, and the link stays empty', async () => {
  const errors: string[] = []
  const events: string[] = []
  const module = tasksModule(async () => ({ ok: false, reason: 'tasks.timeZone: bad' }), recordingLink(events))
  const ctx = context(errors)
  await assert.rejects(async () => await module.start!(ctx), /tasks\.timeZone: bad/)
  assert.deepEqual(errors, ['tasks is off: tasks.timeZone: bad'])
  assert.deepEqual(events, [])
})

test('every route answers 503 starting until start has filled the holder', async () => {
  const module = tasksModule(async () => ({ ok: false, reason: 'x' }), recordingLink([]))
  const routes = module.routes!(context())
  for (const key of Object.keys(routes)) {
    const response = await call(routes, key, { params: { id: 'c1' } })
    assert.equal(response.status, 503, key)
    assert.equal(errorCode(response), 'starting', key)
    assert.equal(response.headers?.['cache-control'], 'no-store', key)
  }
})

test('GET /board answers the view, with no-store; ?cycle= is passed on, and a malformed one is a 400', async () => {
  const { routes, calls } = await started()
  const response = await call(routes, 'GET /board')
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, VIEW)
  assert.equal(response.headers?.['cache-control'], 'no-store')
  assert.equal((await call(routes, 'GET /board', { query: { cycle: '2026-W41' } })).status, 200)
  assert.ok(calls.log.includes('board {"cycle":"2026-W41"}'))
  assert.equal((await call(routes, 'GET /board', { query: { cycle: '2026-W9' } })).status, 400)
})

test('the card routes hand the id and the body over as they came', async () => {
  const { routes, calls } = await started()
  assert.equal((await call(routes, 'POST /tasks', { body: { title: 't', status: 'todo' } })).status, 200)
  assert.equal((await call(routes, 'POST /tasks/:id', { params: { id: 'c1' }, body: { title: 'x' } })).status, 200)
  assert.equal((await call(routes, 'POST /tasks/:id/move', { params: { id: 'c1' }, body: { status: 'done' } })).status, 200)
  assert.equal((await call(routes, 'POST /tasks/:id/accept', { params: { id: 'c1' }, body: { to: 'todo' } })).status, 200)
  assert.equal((await call(routes, 'POST /tasks/:id/sessions', { params: { id: 'c1' }, body: { host: null } })).status, 200)
  assert.deepEqual(calls.log.filter((l) => !l.startsWith('board')), [
    'create [{"title":"t","status":"todo"}]',
    'patch ["c1",{"title":"x"}]',
    'move ["c1",{"status":"done"}]',
    'accept ["c1",{"to":"todo"}]',
    'linkSession ["c1",{"host":null}]',
  ])
  const removed = await call(routes, 'POST /tasks/:id/remove', { params: { id: 'c1' } })
  assert.deepEqual(removed.body, { id: 'c1' })
})

test('GET /tasks/:id finds a card, and a missing one is a 404', async () => {
  const { routes } = await started()
  assert.deepEqual((await call(routes, 'GET /tasks/:id', { params: { id: 'c1' } })).body, CARD)
  const missing = await call(routes, 'GET /tasks/:id', { params: { id: 'nope' } })
  assert.equal(missing.status, 404)
  assert.equal(errorCode(missing), 'not-found')
})

test('an invalid body is a 400 that names the field and why (criterion 10)', async () => {
  const { routes } = await started({ create: async () => ({ ok: false, error: { code: 'invalid', field: 'title', reason: 'Too big' } }) })
  const response = await call(routes, 'POST /tasks', { body: { title: 'x'.repeat(300) } })
  assert.equal(response.status, 400)
  assert.deepEqual(response.body, { error: { code: 'invalid-request', field: 'title', message: 'title: Too big' } })
})

test('each error of the board maps to its status', async () => {
  const fail = (code: 'not-found' | 'conflict' | 'module-error' | 'not-yet') => async () =>
    ({ ok: false, error: { code, reason: 'why' } }) as const
  for (const [code, status] of [['not-found', 404], ['conflict', 409], ['module-error', 500], ['not-yet', 501]] as const) {
    const { routes } = await started({ patch: fail(code) })
    const response = await call(routes, 'POST /tasks/:id', { params: { id: 'c1' }, body: {} })
    assert.equal(response.status, status, code)
    assert.equal(errorCode(response), code, code)
  }
})

test('closing a cycle twice is a 409 (criterion 17)', async () => {
  let closes = 0
  const { routes } = await started({
    closeCycles: async () => (++closes === 1 ? { ok: true, value: [CLOSED] } : { ok: false, error: { code: 'conflict', reason: 'already closed' } }),
  })
  const first = await call(routes, 'POST /cycles/close', { body: { from: '2026-W41' } })
  assert.equal(first.status, 200)
  assert.deepEqual(first.body, { closed: [CLOSED] })
  assert.equal((await call(routes, 'POST /cycles/close', { body: { from: '2026-W41' } })).status, 409)
})

test('the history: GET /cycles lists, GET /cycles/:id opens one, and an unknown one is a 404', async () => {
  const { routes } = await started()
  const list = await call(routes, 'GET /cycles')
  assert.equal((list.body as { cycles: unknown[] }).cycles.length, 1)
  assert.deepEqual((await call(routes, 'GET /cycles/:id', { params: { id: '2026-W41' } })).body, CLOSED)
  assert.equal((await call(routes, 'GET /cycles/:id', { params: { id: '2026-W30' } })).status, 404)
  assert.equal((await call(routes, 'GET /cycles/:id', { params: { id: 'nope' } })).status, 400)
})

test('POST /capture is a 202 with the card in triage, and the body goes over as it came (criterion 21)', async () => {
  const { routes, calls } = await started()
  const response = await call(routes, 'POST /capture', { body: { text: 'comprar pan' } })
  assert.equal(response.status, 202)
  assert.equal(response.headers?.['cache-control'], 'no-store')
  assert.equal((response.body as Task).status, 'triage')
  assert.deepEqual(calls.log, ['capture [{"text":"comprar pan"}]'])
})

test('POST /capture with a bad body is a 400 with its field', async () => {
  const { routes } = await started({ capture: async () => ({ ok: false, error: { code: 'invalid', field: 'text', reason: 'too long' } }) })
  const response = await call(routes, 'POST /capture', { body: { text: '' } })
  assert.equal(response.status, 400)
  assert.equal((response.body as { error: { field: string } }).error.field, 'text')
})

test('GET /triage lists the cards in triage and how many are still being read (criterion 19)', async () => {
  const { routes } = await started()
  const response = await call(routes, 'GET /triage')
  assert.equal(response.status, 200)
  const body = response.body as { tasks: Task[]; pending: number }
  assert.equal(body.tasks.length, 1)
  assert.equal(body.pending, 1)
})

test("POST /next is a 202 that starts a run; one already running is a 409 (criterion 38)", async () => {
  const { routes, calls } = await started()
  const response = await call(routes, 'POST /next')
  assert.equal(response.status, 202)
  assert.deepEqual(response.body, { started: true })
  assert.deepEqual(calls.log, ['runNext'])
  const busy = await started({ runNext: () => ({ ok: false, error: { code: 'conflict', reason: 'already thinking' } }) })
  assert.equal((await call(busy.routes, 'POST /next')).status, 409)
})

test('GET /next answers where it stands and the last answer, with no-store (criterion 40)', async () => {
  const { routes } = await started()
  const response = await call(routes, 'GET /next')
  assert.equal(response.status, 200)
  assert.equal(response.headers?.['cache-control'], 'no-store')
  assert.deepEqual((response.body as { last: { items: unknown[] } }).last.items, [{ id: 'c1', why: 'due' }])
})

test('GET /where in board mode says board; POST /agent-tasks hands the body over and answers 200 with the result', async () => {
  const { routes, calls } = await started()
  assert.deepEqual((await call(routes, 'GET /where')).body, { mode: 'board' })
  const response = await call(routes, 'POST /agent-tasks', { body: { title: 'x', sessionId: 's', siteId: 'n' } })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { content: [{ type: 'text', text: 'added' }] })
  assert.deepEqual(calls.log, ['fromPeer {"title":"x","sessionId":"s","siteId":"n"}'])
})

test('R0b: in relay mode GET /where says where the board is, and every other route is a 501 that names it', async () => {
  const events: string[] = []
  const relay = { where: () => ({ mode: 'relay', host: 'omarchy' }) as const, agent: AGENT, stop: async () => void events.push('relay stopped') }
  const module = tasksModule(async () => ({ ok: true, relay }), recordingLink(events))
  const ctx = context()
  const routes = module.routes!(ctx)
  const handle = await module.start!(ctx)
  assert.deepEqual((await call(routes, 'GET /where')).body, { mode: 'relay', host: 'omarchy' })
  for (const key of ['GET /board', 'POST /tasks', 'POST /capture', 'GET /triage', 'POST /agent-tasks', 'GET /next']) {
    const response = await call(routes, key)
    assert.equal(response.status, 501, key)
    assert.equal((response.body as { error: { host: string } }).error.host, 'omarchy', key)
  }
  // The relay's create_task fills the link, as the board's does.
  assert.deepEqual(events, ['fill'])
  await handle?.stop?.()
  assert.deepEqual(events, ['fill', 'clear', 'relay stopped'])
})
