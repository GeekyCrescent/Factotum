import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isUploadRoute, type ModuleContext, type ModuleRequest, type ModuleResponse, type RouteTable } from '@factotum/core'
import { mockupsConfigSchema } from './config.ts'
import { mockupsModule } from './server.ts'
import type { AgentToolImpl, CreateMockups, Mockup, Mockups, MockupsDeps, MockupsLink, Result } from './types.ts'

const MOCKUP = { id: 'm1', name: 'N' } as unknown as Mockup
const AGENT: AgentToolImpl = { tools: () => [{ name: 'submit_stage', description: 'd', inputSchema: {} }], call: async () => ({ content: [] }) }

function fakeMockups(log: string[], over: Partial<Mockups> = {}): Mockups {
  const answer =
    <T>(name: string, value: Result<T>) =>
    async (...args: unknown[]): Promise<Result<T>> => {
      log.push(`${name} ${JSON.stringify(args)}`)
      return value
    }
  const ok = <T>(value: T): Result<T> => ({ ok: true, value })
  return {
    setup: () => ({ docsSiteId: 'personal', projectsDir: '/p', workRoot: '/w', crossWritesAllowed: false }),
    list: () => [MOCKUP],
    get: (id) => (id === 'm1' ? MOCKUP : undefined),
    projects: async () => ok([{ slug: 'acme', title: 'Acme', workDir: '/w/Acme' }]),
    create: answer('create', ok({ mockup: MOCKUP, mapWarning: 'map not updated: no mapFile in the config' })),
    siteMatch: answer('siteMatch', ok({ siteId: null })),
    setSite: answer('setSite', ok(MOCKUP)),
    addInput: answer('addInput', ok(MOCKUP)),
    addNote: answer('addNote', ok(MOCKUP)),
    docs: answer('docs', ok({ files: [] })),
    startRun: answer('startRun', ok({ runId: 'r', siteId: 'personal', text: 't', title: 'T' })),
    decide: answer('decide', ok({ mockup: MOCKUP })),
    requestChange: answer('requestChange', ok({ mockup: MOCKUP })),
    archive: answer('archive', ok(MOCKUP)),
    linkRun: answer('linkRun', ok(MOCKUP)),
    stallRun: answer('stallRun', ok(MOCKUP)),
    abandonRun: answer('abandonRun', ok(MOCKUP)),
    agent: AGENT,
    stop: async () => void log.push('stop'),
    ...over,
  }
}

function recordingLink(events: string[]): MockupsLink {
  return {
    family: { tools: () => [], call: async () => ({ content: [] }) },
    fill: () => void events.push('fill'),
    clear: () => void events.push('clear'),
  }
}

function context(errors: string[] = []): ModuleContext<unknown> {
  return {
    config: { docsSiteId: 'personal' },
    stateDir: '/tmp/never-written',
    env: 'dev',
    log: { info: () => undefined, warn: () => undefined, error: (message) => void errors.push(message) },
    now: () => new Date('2026-11-12T00:00:00Z'),
    timers: { setInterval: () => ({ [Symbol.dispose]: () => undefined }), setTimeout: () => ({ [Symbol.dispose]: () => undefined }) },
    notify: { canReach: () => false, send: async () => undefined },
    peers: {
      list: () => [],
      json: async () => ({ ok: false, status: undefined, reason: 'unreachable', body: undefined }) as const,
      upload: async () => ({ ok: false, status: undefined, reason: 'unreachable', body: undefined }) as const,
    },
  }
}

function call(routes: RouteTable, key: string, req: Partial<ModuleRequest> = {}): Promise<ModuleResponse> {
  const handler = routes[key]
  if (handler === undefined) throw new Error(`no route ${key}`)
  return Promise.resolve(handler({ method: key.split(' ')[0]!, path: '/', params: {}, query: {}, body: undefined, ...req }))
}

const errorCode = (response: ModuleResponse): string | undefined => (response.body as { error?: { code?: string } } | undefined)?.error?.code

async function started(over: Partial<Mockups> = {}) {
  const log: string[] = []
  const events: string[] = []
  const deps: MockupsDeps[] = []
  const create: CreateMockups = async (setup) => {
    deps.push(setup)
    events.push('created')
    return { ok: true, mockups: fakeMockups(log, over) }
  }
  const module = mockupsModule(create, recordingLink(events))
  const ctx = context()
  const routes = module.routes!(ctx)
  const handle = await module.start!(ctx)
  return { routes, log, events, deps, stop: async () => await handle?.stop?.() }
}

test('the module: id mockups, its nav entry, and its fragment carried unparsed', () => {
  const module = mockupsModule(async () => ({ ok: false, reason: 'x' }), recordingLink([]))
  assert.equal(module.id, 'mockups')
  assert.deepEqual(module.nav, { label: 'Mockups', icon: 'stack', order: 6 })
  const fragment = { anything: { at: 'all' } }
  assert.deepEqual(mockupsConfigSchema.parse(fragment), fragment)
})

test('crit. 4: before start finishes, every route answers 503 starting, no-store', async () => {
  const module = mockupsModule(async () => ({ ok: false, reason: 'x' }), recordingLink([]))
  const routes = module.routes!(context())
  for (const key of Object.keys(routes)) {
    const response = await call(routes, key, { params: { id: 'm1', runId: 'r', stage: 'brief' } })
    assert.equal(response.status, 503, key)
    assert.equal(errorCode(response), 'starting', key)
    assert.equal(response.headers?.['cache-control'], 'no-store', key)
  }
})

test('start hands over the raw fragment and the kernel’s pieces, and fills the link LAST; stop clears it first', async () => {
  const { deps, events, stop, log } = await started()
  assert.deepEqual(deps[0]?.config, { docsSiteId: 'personal' })
  assert.equal(deps[0]?.stateDir, '/tmp/never-written')
  assert.deepEqual(events, ['created', 'fill'])
  await stop()
  assert.deepEqual(events, ['created', 'fill', 'clear'])
  assert.deepEqual(log, ['stop'])
})

test('crit. 2: a failed factory throws with its reason, logs it, and never fills the link', async () => {
  const events: string[] = []
  const errors: string[] = []
  const module = mockupsModule(async () => ({ ok: false, reason: 'mockups.workRoot: must be an absolute path' }), recordingLink(events))
  await assert.rejects(Promise.resolve(module.start!(context(errors))), /workRoot/)
  assert.deepEqual(errors, ['mockups is off: mockups.workRoot: must be an absolute path'])
  assert.deepEqual(events, [])
})

test('the D8 routes, GET and POST only, the changes route included (crit. 36)', async () => {
  const { routes } = await started()
  assert.deepEqual(Object.keys(routes).sort(), [
    'GET /mockups',
    'GET /mockups/:id',
    'GET /mockups/:id/docs/:stage',
    'GET /projects',
    'POST /mockups',
    'POST /mockups/:id/archive',
    'POST /mockups/:id/changes',
    'POST /mockups/:id/decision',
    'POST /mockups/:id/inputs',
    'POST /mockups/:id/notes',
    'POST /mockups/:id/runs',
    'POST /mockups/:id/site',
    'POST /mockups/:id/site-match',
    'POST /runs/:runId/abandon',
    'POST /runs/:runId/session',
    'POST /runs/:runId/stall',
  ])
  assert.ok(isUploadRoute(routes['POST /mockups/:id/inputs']!))
  assert.equal((routes['POST /mockups/:id/inputs'] as { upload: { maxBytes: number } }).upload.maxBytes, 50 * 1024 * 1024)
})

test('GET /mockups answers the gallery and the setup; GET /projects the vault projects; all no-store', async () => {
  const { routes } = await started()
  const gallery = await call(routes, 'GET /mockups')
  assert.equal(gallery.status, 200)
  assert.equal(gallery.headers?.['cache-control'], 'no-store')
  assert.deepEqual(gallery.body, { mockups: [MOCKUP], setup: { docsSiteId: 'personal', projectsDir: '/p', workRoot: '/w', crossWritesAllowed: false } })
  const projects = await call(routes, 'GET /projects')
  assert.deepEqual(projects.body, { projects: [{ slug: 'acme', title: 'Acme', workDir: '/w/Acme' }] })
})

test('GET /mockups/:id: the mockup, or 404', async () => {
  const { routes } = await started()
  assert.equal((await call(routes, 'GET /mockups/:id', { params: { id: 'm1' } })).status, 200)
  const missing = await call(routes, 'GET /mockups/:id', { params: { id: 'nope' } })
  assert.equal(missing.status, 404)
  assert.equal(errorCode(missing), 'not-found')
})

test('every body goes over as it came, with the id from the path', async () => {
  const { routes, log } = await started()
  await call(routes, 'POST /mockups', { body: { a: 1 } })
  await call(routes, 'POST /mockups/:id/site-match', { params: { id: 'm1' }, body: { projects: [] } })
  await call(routes, 'POST /mockups/:id/site', { params: { id: 'm1' }, body: { siteId: 's' } })
  await call(routes, 'POST /mockups/:id/notes', { params: { id: 'm1' }, body: { text: 't' } })
  await call(routes, 'GET /mockups/:id/docs/:stage', { params: { id: 'm1', stage: 'brief' } })
  await call(routes, 'POST /mockups/:id/runs', { params: { id: 'm1' }, body: { kind: 'brief' } })
  await call(routes, 'POST /mockups/:id/decision', { params: { id: 'm1' }, body: { step: 'brief', action: 'approve' } })
  await call(routes, 'POST /mockups/:id/archive', { params: { id: 'm1' } })
  await call(routes, 'POST /mockups/:id/changes', { params: { id: 'm1' }, body: { text: 'logo' } })
  await call(routes, 'POST /runs/:runId/session', { params: { runId: 'r' }, body: { sessionId: 's' } })
  await call(routes, 'POST /runs/:runId/stall', { params: { runId: 'r' } })
  await call(routes, 'POST /runs/:runId/abandon', { params: { runId: 'r' }, body: { reason: 'x' } })
  assert.deepEqual(log, [
    'create [{"a":1}]',
    'siteMatch ["m1",{"projects":[]}]',
    'setSite ["m1",{"siteId":"s"}]',
    'addNote ["m1",{"text":"t"}]',
    'docs ["m1","brief"]',
    'startRun ["m1",{"kind":"brief"}]',
    'decide ["m1",{"step":"brief","action":"approve"}]',
    'archive ["m1"]',
    'requestChange ["m1",{"text":"logo"}]',
    'linkRun ["r",{"sessionId":"s"}]',
    'stallRun ["r"]',
    'abandonRun ["r",{"reason":"x"}]',
  ])
})

test('an upload hands over the kernel’s file and the query; without a file it is a 400', async () => {
  const { routes, log } = await started()
  const ok = await call(routes, 'POST /mockups/:id/inputs', { params: { id: 'm1' }, query: { name: 'a.pdf' }, file: { path: '/s/.incoming/x', bytes: 3 } })
  assert.equal(ok.status, 200)
  assert.deepEqual(log, ['addInput ["m1",{"path":"/s/.incoming/x","bytes":3},{"name":"a.pdf"}]'])
  const none = await call(routes, 'POST /mockups/:id/inputs', { params: { id: 'm1' } })
  assert.equal(none.status, 400)
  assert.equal(errorCode(none), 'invalid-request')
})

test('POST /mockups answers the mockup and the map warning (crit. 6b)', async () => {
  const { routes } = await started()
  const response = await call(routes, 'POST /mockups', { body: {} })
  assert.deepEqual(response.body, { mockup: MOCKUP, mapWarning: 'map not updated: no mapFile in the config' })
})

test('the package’s errors become statuses: 400 with its field, 404, 409, 413, 500, 501', async () => {
  const fail = (error: Result<never> & { ok: false }) => async () => error
  const cases: [Result<never> & { ok: false }, number, string][] = [
    [{ ok: false, error: { code: 'invalid', field: 'name', reason: 'must not be empty' } }, 400, 'invalid-request'],
    [{ ok: false, error: { code: 'not-found', reason: 'x' } }, 404, 'not-found'],
    [{ ok: false, error: { code: 'conflict', reason: 'the work folder already has «A»' } }, 409, 'conflict'],
    [{ ok: false, error: { code: 'too-large', reason: '01-brief.md is over 1 MiB' } }, 413, 'body-too-large'],
    [{ ok: false, error: { code: 'module-error', reason: 'x' } }, 500, 'module-error'],
    [{ ok: false, error: { code: 'not-yet', reason: 'concepts arrives in the next cut' } }, 501, 'not-yet'],
  ]
  for (const [error, status, code] of cases) {
    const { routes } = await started({ startRun: fail(error) as Mockups['startRun'] })
    const response = await call(routes, 'POST /mockups/:id/runs', { params: { id: 'm1' }, body: {} })
    assert.equal(response.status, status, code)
    assert.equal(errorCode(response), code)
    assert.equal(response.headers?.['cache-control'], 'no-store')
  }
  const { routes } = await started({ create: fail({ ok: false, error: { code: 'invalid', field: 'name', reason: 'must not be empty' } }) as Mockups['create'] })
  const invalid = await call(routes, 'POST /mockups', { body: {} })
  assert.deepEqual(invalid.body, { error: { code: 'invalid-request', field: 'name', message: 'name: must not be empty' } })
})
