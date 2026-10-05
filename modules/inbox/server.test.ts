import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModuleContext, ModuleRequest, ModuleResponse, RouteTable } from '@factotum/core'
import { inboxConfigSchema } from './config.ts'
import { inboxModule } from './server.ts'
import type { CreateInbox, Digest, Inbox, InboxSetup } from './types.ts'

const DIGEST: Digest = {
  id: '2026-10-06T0812',
  state: 'ok',
  startedAt: '2026-10-06T07:12:00.000Z',
  endedAt: '2026-10-06T07:12:40.000Z',
  window: { since: '2026-10-04T07:12:00.000Z', until: '2026-10-06T07:12:00.000Z' },
  accounts: [],
  entries: [],
  overflow: 0,
  usage: { batches: 1, failedBatches: 0, inputTokens: 1, outputTokens: 1, costUsd: 0, ms: 40_000, model: 'haiku' },
}

function fakeInbox(over: Partial<Inbox> = {}): Inbox {
  let running = false
  return {
    runNow: () => {
      if (running) return { outcome: 'busy' }
      running = true
      return { outcome: 'started', id: DIGEST.id }
    },
    status: () => ({ running, accounts: [{ id: 'personal', label: 'Gmail' }] }),
    latest: async () => DIGEST,
    list: async (limit) => [{ id: DIGEST.id, state: 'ok', startedAt: DIGEST.startedAt, todo: limit, high: 0 }],
    get: async (id) => (id === DIGEST.id ? DIGEST : undefined),
    stop: async () => undefined,
    ...over,
  }
}

function context(errors: string[] = []): ModuleContext<unknown> {
  return {
    config: { accounts: [] },
    stateDir: '/tmp/never-written',
    env: 'dev',
    log: { info: () => undefined, warn: () => undefined, error: (message) => void errors.push(message) },
    now: () => new Date('2026-10-06T07:12:00.000Z'),
    timers: { setInterval: () => ({ [Symbol.dispose]: () => undefined }), setTimeout: () => ({ [Symbol.dispose]: () => undefined }) },
    notify: { canReach: () => false, send: async () => undefined },
  }
}

async function started(inbox: Inbox = fakeInbox()): Promise<{ routes: RouteTable; setups: InboxSetup[] }> {
  const setups: InboxSetup[] = []
  const create: CreateInbox = async (setup) => {
    setups.push(setup)
    return { ok: true, inbox }
  }
  const module = inboxModule(create)
  const ctx = context()
  const routes = module.routes!(ctx)
  await module.start!(ctx)
  return { routes, setups }
}

function call(routes: RouteTable, key: string, req: Partial<ModuleRequest> = {}): Promise<ModuleResponse> {
  const handler = routes[key]
  if (handler === undefined) throw new Error(`no route ${key}`)
  return Promise.resolve(handler({ method: key.split(' ')[0]!, path: '/', params: {}, query: {}, body: undefined, ...req }))
}

test('the module: id inbox, the nav entry, and its fragment carried unparsed', () => {
  const module = inboxModule(async () => ({ ok: false, reason: 'x' }))
  assert.equal(module.id, 'inbox')
  assert.deepEqual(module.nav, { label: 'Inbox', icon: 'envelope-simple', order: 10 })
  const fragment = { anything: { at: 'all' } }
  assert.deepEqual(inboxConfigSchema.parse(fragment), fragment)
})

test('start hands the raw fragment and the kernel’s state, clock, log and timers over', async () => {
  const { setups } = await started()
  assert.equal(setups.length, 1)
  assert.deepEqual(setups[0]?.config, { accounts: [] })
  assert.equal(setups[0]?.stateDir, '/tmp/never-written')
})

test('POST /run is 202 with the id at once, and 409 while one runs (criteria 17, 19)', async () => {
  const { routes } = await started()
  const before = Date.now()
  const first = await call(routes, 'POST /run')
  assert.ok(Date.now() - before < 1000)
  assert.equal(first.status, 202)
  assert.deepEqual(first.body, { id: DIGEST.id })
  const second = await call(routes, 'POST /run')
  assert.equal(second.status, 409)
  assert.deepEqual(second.body, { error: { code: 'conflict', message: 'already checking' } })
})

test('GET /digests/latest with no digest is 404; with one, the digest', async () => {
  const empty = await started(fakeInbox({ latest: async () => undefined }))
  assert.equal((await call(empty.routes, 'GET /digests/latest')).status, 404)
  const full = await started()
  const response = await call(full.routes, 'GET /digests/latest')
  assert.deepEqual([response.status, response.body], [200, DIGEST])
})

test('GET /digests/:id: a bad id is 400 before the inbox sees it, an unknown one 404', async () => {
  const asked: string[] = []
  const { routes } = await started(fakeInbox({ get: async (id) => (asked.push(id), id === DIGEST.id ? DIGEST : undefined) }))
  for (const id of ['../../etc/passwd', '2026-10-06', 'latest2', '']) {
    assert.equal((await call(routes, 'GET /digests/:id', { params: { id } })).status, 400, id)
  }
  assert.deepEqual(asked, [])
  assert.equal((await call(routes, 'GET /digests/:id', { params: { id: '2026-10-06T0900' } })).status, 404)
  const found = await call(routes, 'GET /digests/:id', { params: { id: DIGEST.id } })
  assert.deepEqual([found.status, found.body], [200, DIGEST])
})

test('GET /digests: 30 by default, a limit from 1 to 100, anything else 400', async () => {
  const { routes } = await started()
  const plain = await call(routes, 'GET /digests')
  assert.deepEqual((plain.body as { digests: { todo: number }[] }).digests[0]?.todo, 30)
  const five = await call(routes, 'GET /digests', { query: { limit: '5' } })
  assert.deepEqual((five.body as { digests: { todo: number }[] }).digests[0]?.todo, 5)
  for (const limit of ['0', '101', 'x', '2.5']) assert.equal((await call(routes, 'GET /digests', { query: { limit } })).status, 400, limit)
})

test('GET /status is the inbox’s status; every answer is no-store', async () => {
  const { routes } = await started()
  const response = await call(routes, 'GET /status')
  assert.deepEqual(response.body, { running: false, accounts: [{ id: 'personal', label: 'Gmail' }] })
  for (const key of ['GET /status', 'GET /digests', 'GET /digests/latest', 'POST /run']) {
    assert.equal((await call(routes, key)).headers?.['cache-control'], 'no-store', key)
  }
})

test('before start, every route is 503 starting', async () => {
  const module = inboxModule(async () => ({ ok: true, inbox: fakeInbox() }))
  const routes = module.routes!(context())
  for (const key of Object.keys(routes)) assert.equal((await call(routes, key, { params: { id: DIGEST.id } })).status, 503, key)
})

test('a bad config disables the module: the reason goes to ctx.log.error, then start throws (criteria 1, 3)', async () => {
  const errors: string[] = []
  const module = inboxModule(async () => ({ ok: false, reason: 'inbox.model: model must match /^[a-z0-9][a-z0-9.-]{0,63}$/, like "haiku"' }))
  await assert.rejects(Promise.resolve(module.start!(context(errors))), /inbox\.model/)
  assert.deepEqual(errors, ['inbox is off: inbox.model: model must match /^[a-z0-9][a-z0-9.-]{0,63}$/, like "haiku"'])
})

test('stop is the inbox’s stop', async () => {
  let stopped = 0
  const module = inboxModule(async () => ({ ok: true, inbox: fakeInbox({ stop: async () => void (stopped += 1) }) }))
  const handle = await module.start!(context())
  await handle.stop()
  assert.equal(stopped, 1)
})
