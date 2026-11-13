import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModuleContext, ModuleRequest, ModuleResponse, RouteTable } from '@factotum/core'
import type { BatchAnswer, DecideAnswer, SendView } from './client/contract.ts'
import { jobsConfigSchema } from './config.ts'
import { jobsModule } from './server.ts'
import type { CreateJobs, Jobs, JobsErrorCode, JobsSetup, Result, Send } from './types.ts'

const ID = '019a6f2e-7c1d-7000-8000-000000000001'
const PNG_PATH = '/tmp/never-written/artifacts/a1/v2/preview.png'
const PDF_PATH = '/tmp/never-written/artifacts/a1/v2/cv.pdf'

const SEND: Send = { kind: 'initial', state: 'sending', at: '2026-11-13T00:00:00.000Z', reason: null }
/** The engine's row carries more than the poll reads; none of it may leave. */
const SEND_ROW = { ...SEND, messageId: '<x@jobs.factotum.local>', response: '250 OK smtp.gmail.com', attempts: [] }

const ANSWER: BatchAnswer = { batch: { id: 'b1', test: false, items: [], cursor: 0, results: {}, rewriting: 0 }, ready: 3 }

interface Calls {
  readonly log: string[]
}

function fakeJobs(calls: Calls, over: Partial<Jobs> = {}): Jobs {
  const record =
    <T>(name: string, value: T) =>
    (...args: unknown[]): T => {
      calls.log.push(`${name} ${JSON.stringify(args)}`)
      return value
    }
  return {
    overview: record('overview', { ready: 3 }),
    application: record('application', { ok: true, value: { id: ID } }),
    startBatch: record('startBatch', { ok: true, value: ANSWER }),
    batch: record('batch', { ok: true, value: { batch: null, ready: 0 } }),
    decide: record('decide', { ok: true, value: { send: { state: 'sending' } } }),
    send: record('send', { ok: true, value: SEND_ROW }),
    markSent: record('markSent', { ok: true, value: { id: ID, state: 'sent' } }),
    resolveUnknown: record('resolveUnknown', { ok: true, value: { ...SEND_ROW, state: 'sent' } }),
    retrySend: record('retrySend', { ok: true, value: SEND_ROW }),
    retryJob: record('retryJob', { ok: true, value: { queued: true } }),
    close: record('close', { ok: true, value: {} }),
    profile: record('profile', { version: 4, createdAt: 'a', profile: { level: 'junior' } }),
    saveProfile: record('saveProfile', { ok: true, value: { version: 5, createdAt: 'b', profile: {}, relinted: 2 } }),
    rules: record('rules', [{ id: 'r1', text: 'no emoji', scope: 'all', enabled: true }]),
    saveRule: record('saveRule', { ok: true, value: { id: 'r1', text: 'no emoji', scope: 'all', enabled: true, relinted: 1 } }),
    importSeed: async (input) => {
      calls.log.push(`importSeed ${JSON.stringify([input])}`)
      return { ok: true, value: { imported: 0 } }
    },
    health: record('health', { password: 'ok' }),
    file: (id, version, kind) => {
      calls.log.push(`file ${JSON.stringify([id, version, kind])}`)
      return { ok: true, value: kind === 'png' ? PNG_PATH : PDF_PATH }
    },
    stop: async () => {
      calls.log.push('stop')
    },
    ...over,
  }
}

function context(errors: string[] = []): ModuleContext<unknown> {
  return {
    config: { timeZone: 'Australia/Sydney' },
    stateDir: '/tmp/never-written',
    env: 'dev',
    log: { info: () => undefined, warn: () => undefined, error: (message) => void errors.push(message) },
    now: () => new Date('2026-11-13T00:00:00Z'),
    timers: { setInterval: () => ({ [Symbol.dispose]: () => undefined }), setTimeout: () => ({ [Symbol.dispose]: () => undefined }) },
    notify: { canReach: () => false, send: async () => undefined },
    peers: {
      list: () => [],
      json: async () => ({ ok: false, status: undefined, reason: 'unreachable', body: undefined }) as const,
      upload: async () => ({ ok: false, status: undefined, reason: 'unreachable', body: undefined }) as const,
    },
  }
}

interface Started {
  readonly routes: RouteTable
  readonly setups: JobsSetup[]
  readonly calls: Calls
  readonly errors: string[]
  readonly stop: () => Promise<void>
}

async function started(over: Partial<Jobs> = {}): Promise<Started> {
  const setups: JobsSetup[] = []
  const calls: Calls = { log: [] }
  const errors: string[] = []
  const create: CreateJobs = async (setup) => {
    setups.push(setup)
    return { ok: true, jobs: fakeJobs(calls, over) }
  }
  const module = jobsModule(create)
  const ctx = context(errors)
  const routes = module.routes!(ctx)
  const handle = await module.start!(ctx)
  return { routes, setups, calls, errors, stop: async () => await handle?.stop?.() }
}

function call(routes: RouteTable, key: string, req: Partial<ModuleRequest> = {}): Promise<ModuleResponse> {
  const handler = routes[key]
  if (handler === undefined) throw new Error(`no route ${key}`)
  return Promise.resolve(handler({ method: key.split(' ')[0]!, path: '/', params: {}, query: {}, body: undefined, ...req }))
}

function errorOf(response: ModuleResponse): { code?: string; message?: string; field?: string } | undefined {
  return (response.body as { error?: { code?: string; message?: string; field?: string } } | undefined)?.error
}

const failing = (code: JobsErrorCode, reason: string, field?: string) => (): Result<never> =>
  ({ ok: false, error: field === undefined ? { code, reason } : { code, reason, field } })

const PARAMS = { id: ID, kind: 'initial', version: '2', name: 'Juan-Rodrigo-Ferro-Rayon-CV-Acme.pdf', ruleId: 'r1' }

// ── The module ───────────────────────────────────────────────────────────────────────────────────

test('the module: id jobs, «Jobs» with the briefcase at 7, and its fragment carried unparsed', () => {
  const module = jobsModule(async () => ({ ok: false, reason: 'x' }))
  assert.equal(module.id, 'jobs')
  assert.deepEqual(module.nav, { label: 'Jobs', icon: 'briefcase', order: 7 })
  const fragment = { anything: { at: 'all' } }
  assert.deepEqual(jobsConfigSchema.parse(fragment), fragment)
})

test('start hands over the raw fragment and the kernel’s state dir, clock, timers and notifier', async () => {
  const { setups } = await started()
  assert.equal(setups.length, 1)
  assert.deepEqual(setups[0]?.config, { timeZone: 'Australia/Sydney' })
  assert.equal(setups[0]?.stateDir, '/tmp/never-written')
  assert.equal(setups[0]?.now().toISOString(), '2026-11-13T00:00:00.000Z')
})

test('stop stops the engine', async () => {
  const { stop, calls } = await started()
  await stop()
  assert.deepEqual(calls.log, ['stop'])
})

test('a factory that refuses: start throws with the reason and logs it, and the routes stay 503', async () => {
  const errors: string[] = []
  const module = jobsModule(async () => ({ ok: false, reason: 'jobs.timeZone: not a time zone' }))
  const ctx = context(errors)
  const routes = module.routes!(ctx)
  await assert.rejects(async () => await module.start!(ctx), /jobs\.timeZone: not a time zone/)
  assert.deepEqual(errors, ['jobs is off: jobs.timeZone: not a time zone'])
  assert.equal((await call(routes, 'GET /batch')).status, 503)
})

test('every route answers 503 starting, no-store, until start has filled the holder (crit. 4)', async () => {
  const module = jobsModule(async () => ({ ok: false, reason: 'x' }))
  const routes = module.routes!(context())
  const keys = Object.keys(routes)
  assert.ok(keys.length >= 17, `only ${keys.length} routes`)
  for (const key of keys) {
    const response = await call(routes, key, { params: PARAMS, body: {} })
    assert.equal(response.status, 503, key)
    assert.equal(errorOf(response)?.code, 'starting', key)
    assert.equal(response.headers?.['cache-control'], 'no-store', key)
  }
})

test('only GET and POST (ADR-0019), and every JSON answer of a started module is no-store', async () => {
  const { routes } = await started()
  for (const key of Object.keys(routes)) {
    assert.match(key, /^(GET|POST) \//, key)
    const response = await call(routes, key, { params: PARAMS, body: { answer: 'went', job: 'cv', dryRun: true } })
    if (response.file !== undefined) continue
    assert.equal(response.headers?.['cache-control'], 'no-store', key)
    assert.ok(response.status < 500, `${key} answered ${response.status}`)
  }
})

test('the routes the client already calls are all there (client/contract.ts)', async () => {
  const { routes } = await started()
  for (const key of [
    'GET /batch',
    'POST /batch',
    'POST /batch/decide',
    'GET /a/:id/sends/:kind',
    'POST /a/:id/sends/:kind/retry',
    'POST /a/:id/retry',
    'POST /rules',
    'GET /a/:id/v/:version/preview.png',
    'GET /a/:id/v/:version/:name',
  ]) {
    assert.ok(routes[key] !== undefined, key)
  }
})

// ── The batch ────────────────────────────────────────────────────────────────────────────────────

test('GET /batch and POST /batch answer { batch, ready } as the engine resolved it', async () => {
  const { routes, calls } = await started()
  const read = await call(routes, 'GET /batch')
  assert.equal(read.status, 200)
  assert.deepEqual(read.body, { batch: null, ready: 0 })
  const armed = await call(routes, 'POST /batch')
  assert.equal(armed.status, 200)
  assert.deepEqual(armed.body, ANSWER)
  assert.deepEqual(calls.log, ['batch []', 'startBatch []'])
})

test('POST /batch/decide hands the body over as it came, and answers { ok, state } without waiting for SMTP', async () => {
  const { routes, calls } = await started()
  const decision = { itemId: 'i1', kind: 'approve', seen: 'abc' }
  const response = await call(routes, 'POST /batch/decide', { body: decision })
  assert.equal(response.status, 200)
  const expected: DecideAnswer = { ok: true, state: 'sending' }
  assert.deepEqual(response.body, expected)
  assert.deepEqual(calls.log, [`decide [${JSON.stringify(decision)}]`])
})

test('a decision that sends nothing answers { ok: true } alone', async () => {
  const { routes } = await started({ decide: () => ({ ok: true, value: {} }) })
  assert.deepEqual((await call(routes, 'POST /batch/decide', { body: { itemId: 'i1', kind: 'skip' } })).body, { ok: true })
})

test('a stale card is a 409 whose message is the reason the client reads (D15, `stale`)', async () => {
  const { routes } = await started({ decide: failing('conflict', 'stale') })
  const response = await call(routes, 'POST /batch/decide', { body: { itemId: 'i1', kind: 'approve', seen: 'old' } })
  assert.equal(response.status, 409)
  assert.deepEqual(errorOf(response), { code: 'conflict', message: 'stale' })
})

// ── The error mapping (D13 «Errores») ────────────────────────────────────────────────────────────

test('invalid is a 400 that names the field', async () => {
  const { routes } = await started({ decide: failing('invalid', 'too long', 'text') })
  const response = await call(routes, 'POST /batch/decide', { body: { itemId: 'i1', kind: 'instruct', text: 'x' } })
  assert.equal(response.status, 400)
  assert.deepEqual(errorOf(response), { code: 'invalid-request', field: 'text', message: 'text: too long' })
})

test('not-found is a 404', async () => {
  const { routes } = await started({ application: failing('not-found', 'there is no such application') })
  const response = await call(routes, 'GET /a/:id', { params: { id: 'nope' } })
  assert.equal(response.status, 404)
  assert.deepEqual(errorOf(response), { code: 'not-found', message: 'there is no such application' })
})

test('conflict is a 409 (check-pending: the client waits for the poll)', async () => {
  const { routes } = await started({ decide: failing('conflict', 'check-pending') })
  const response = await call(routes, 'POST /batch/decide', { body: { itemId: 'i1', kind: 'approve' } })
  assert.equal(response.status, 409)
  assert.deepEqual(errorOf(response), { code: 'conflict', message: 'check-pending' })
})

test('blocked is a 422 (address-unverified: «Send anyway» or «Switch to form»)', async () => {
  const { routes } = await started({ decide: failing('blocked', 'address-unverified') })
  const response = await call(routes, 'POST /batch/decide', { body: { itemId: 'i1', kind: 'approve' } })
  assert.equal(response.status, 422)
  assert.deepEqual(errorOf(response), { code: 'blocked', message: 'address-unverified' })
})

test('limit is a 429', async () => {
  const { routes } = await started({ retrySend: failing('limit', 'daily cap reached') })
  const response = await call(routes, 'POST /a/:id/sends/:kind/retry', { params: { id: ID, kind: 'initial' } })
  assert.equal(response.status, 429)
  assert.deepEqual(errorOf(response), { code: 'limit', message: 'daily cap reached' })
})

test('module-error is a 500 whose cause goes to the log and never to the screen', async () => {
  const errors: string[] = []
  const create: CreateJobs = async () => ({
    ok: true,
    jobs: fakeJobs({ log: [] }, { startBatch: () => ({ ok: false, error: { code: 'module-error', reason: 'the store failed', cause: new Error('SQLITE_BUSY at /secret/path') } }) }),
  })
  const module = jobsModule(create)
  const ctx = context(errors)
  const routes = module.routes!(ctx)
  await module.start!(ctx)
  const response = await call(routes, 'POST /batch')
  assert.equal(response.status, 500)
  assert.deepEqual(errorOf(response), { code: 'module-error', message: 'the store failed' })
  assert.doesNotMatch(JSON.stringify(response.body), /SQLITE_BUSY|secret/)
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /the store failed/)
  assert.match(errors[0]!, /SQLITE_BUSY/)
})

// ── Sends (D9) ───────────────────────────────────────────────────────────────────────────────────

test('GET /a/:id/sends/:kind answers { kind, state, at, reason } and nothing else of the row', async () => {
  const { routes, calls } = await started()
  const response = await call(routes, 'GET /a/:id/sends/:kind', { params: { id: ID, kind: 'initial' } })
  assert.equal(response.status, 200)
  const expected: SendView = { kind: 'initial', state: 'sending', at: SEND.at, reason: null }
  assert.deepEqual(response.body, expected)
  assert.deepEqual(calls.log, [`send ["${ID}","initial"]`])
})

test('a send kind that is not one is a 400 on kind, and the engine is never asked', async () => {
  const { routes, calls } = await started()
  for (const key of ['GET /a/:id/sends/:kind', 'POST /a/:id/sends/:kind/mark', 'POST /a/:id/sends/:kind/retry', 'POST /a/:id/sends/:kind/unknown']) {
    const response = await call(routes, key, { params: { id: ID, kind: 'followup-3' }, body: { answer: 'went' } })
    assert.equal(response.status, 400, key)
    assert.equal(errorOf(response)?.field, 'kind', key)
  }
  assert.deepEqual(calls.log, [])
})

test('mark, retry and unknown hand the send over; unknown checks its answer', async () => {
  const { routes, calls } = await started()
  const params = { id: ID, kind: 'followup-1' }
  assert.equal((await call(routes, 'POST /a/:id/sends/:kind/mark', { params })).status, 200)
  const retried = await call(routes, 'POST /a/:id/sends/:kind/retry', { params })
  assert.deepEqual(retried.body, { kind: 'initial', state: 'sending', at: SEND.at, reason: null })
  const resolved = await call(routes, 'POST /a/:id/sends/:kind/unknown', { params, body: { answer: 'not-went' } })
  assert.equal((resolved.body as SendView).state, 'sent')
  const bad = await call(routes, 'POST /a/:id/sends/:kind/unknown', { params, body: { answer: 'maybe' } })
  assert.equal(bad.status, 400)
  assert.equal(errorOf(bad)?.field, 'answer')
  assert.deepEqual(calls.log, [`markSent ["${ID}","followup-1"]`, `retrySend ["${ID}","followup-1"]`, `resolveUnknown ["${ID}","followup-1","not-went"]`])
})

test('POST /a/:id/retry { job } asks the engine again; a job that is not one is a 400 on job', async () => {
  const { routes, calls } = await started()
  const response = await call(routes, 'POST /a/:id/retry', { params: { id: ID }, body: { job: 'reprint' } })
  assert.equal(response.status, 200)
  assert.deepEqual(calls.log, [`retryJob ["${ID}","reprint"]`])
  for (const body of [{ job: 'rewrite' }, {}, undefined, 'cv']) {
    const bad = await call(routes, 'POST /a/:id/retry', { params: { id: ID }, body })
    assert.equal(bad.status, 400, JSON.stringify(body))
    assert.equal(errorOf(bad)?.field, 'job')
  }
})

// ── The files (D5 «Servir») ──────────────────────────────────────────────────────────────────────

test('the preview is the engine’s path for the png, served by the kernel (inline from its bytes)', async () => {
  const { routes, calls } = await started()
  const response = await call(routes, 'GET /a/:id/v/:version/preview.png', { params: { id: ID, version: '2' } })
  assert.equal(response.status, 200)
  assert.equal(response.file, PNG_PATH)
  assert.deepEqual(calls.log, [`file ["${ID}",2,"png"]`])
})

test('the PDF is the engine’s path for the pdf; the last part of the path is its name for the download', async () => {
  const { routes, calls } = await started()
  const response = await call(routes, 'GET /a/:id/v/:version/:name', { params: { id: ID, version: '2', name: 'Juan-Rodrigo-Ferro-Rayon-CV-Acme.pdf' } })
  assert.equal(response.status, 200)
  assert.equal(response.file, PDF_PATH)
  assert.deepEqual(calls.log, [`file ["${ID}",2,"pdf"]`])
})

test('a file name outside the closed alphabet is a 404, and the engine is never asked', async () => {
  const { routes, calls } = await started()
  for (const name of [
    'cv.html',
    'cv.svg',
    'cv.PDF.exe',
    '../cv.pdf',
    '..',
    'cv pdf.pdf',
    'Ferro-Rayón-CV.pdf',
    'a/b.pdf',
    '.pdf',
    '-cv.pdf',
    `${'a'.repeat(121)}.pdf`,
    'cv.pdf%00.png',
    'cv\u0000.pdf',
  ]) {
    const response = await call(routes, 'GET /a/:id/v/:version/:name', { params: { id: ID, version: '2', name } })
    assert.equal(response.status, 404, name)
    assert.equal(response.file, undefined, name)
  }
  assert.deepEqual(calls.log, [])
})

test('path traversal in the id or the version is refused before the engine is asked', async () => {
  const { routes, calls } = await started()
  const cases: readonly Record<string, string>[] = [
    { id: '../../etc', version: '2' },
    { id: '..', version: '2' },
    { id: 'a/b', version: '2' },
    { id: '', version: '2' },
    { id: ID, version: '../2' },
    { id: ID, version: '0' },
    { id: ID, version: '-1' },
    { id: ID, version: '1.5' },
    { id: ID, version: '02' },
    { id: ID, version: '9999999' },
  ]
  for (const params of cases) {
    const png = await call(routes, 'GET /a/:id/v/:version/preview.png', { params })
    const pdf = await call(routes, 'GET /a/:id/v/:version/:name', { params: { ...params, name: 'cv.pdf' } })
    assert.equal(png.status, 404, JSON.stringify(params))
    assert.equal(pdf.status, 404, JSON.stringify(params))
    assert.equal(png.headers?.['cache-control'], 'no-store')
  }
  assert.deepEqual(calls.log, [])
})

test('a file the engine does not have is a 404 with no file', async () => {
  const { routes } = await started({ file: failing('not-found', 'no such version') })
  const response = await call(routes, 'GET /a/:id/v/:version/preview.png', { params: { id: ID, version: '3' } })
  assert.equal(response.status, 404)
  assert.equal(response.file, undefined)
})

test('a path the engine answers that is not absolute is never handed to the kernel', async () => {
  const { routes } = await started({ file: () => ({ ok: true, value: 'artifacts/a1/v2/cv.pdf' }) })
  const response = await call(routes, 'GET /a/:id/v/:version/:name', { params: { id: ID, version: '2', name: 'cv.pdf' } })
  assert.equal(response.file, undefined)
  assert.equal(response.status, 500)
})

// ── The rest of cut 1a ───────────────────────────────────────────────────────────────────────────

test('GET /overview, GET /health and GET /a/:id hand over what the engine answers', async () => {
  const { routes, calls } = await started()
  assert.deepEqual((await call(routes, 'GET /overview')).body, { ready: 3 })
  assert.deepEqual((await call(routes, 'GET /health')).body, { password: 'ok' })
  assert.deepEqual((await call(routes, 'GET /a/:id', { params: { id: ID } })).body, { id: ID })
  assert.deepEqual(calls.log, ['overview []', 'health []', `application ["${ID}"]`])
})

test('the profile: GET reads, POST hands the body over as it came', async () => {
  const { routes, calls } = await started()
  assert.equal(((await call(routes, 'GET /profile')).body as { version: number }).version, 4)
  const saved = await call(routes, 'POST /profile', { body: { level: 'junior' } })
  assert.equal(saved.status, 200)
  assert.equal((saved.body as { relinted: number }).relinted, 2)
  assert.deepEqual(calls.log, ['profile []', 'saveProfile [{"level":"junior"}]'])
})

test('the rules: GET lists, POST /rules adds, POST /rules/:ruleId edits that one', async () => {
  const { routes, calls } = await started()
  assert.equal(((await call(routes, 'GET /rules')).body as { rules: unknown[] }).rules.length, 1)
  assert.equal((await call(routes, 'POST /rules', { body: { text: 'no emoji', scope: 'all' } })).status, 200)
  assert.equal((await call(routes, 'POST /rules/:ruleId', { params: { ruleId: 'r1' }, body: { enabled: false } })).status, 200)
  assert.deepEqual(calls.log, ['rules []', 'saveRule [{"text":"no emoji","scope":"all"}]', 'saveRule [{"enabled":false},"r1"]'])
})

test('POST /import { dryRun } runs the seed; dryRun must be a boolean', async () => {
  const { routes, calls } = await started()
  assert.equal((await call(routes, 'POST /import', { body: { dryRun: true } })).status, 200)
  assert.equal((await call(routes, 'POST /import', { body: { dryRun: false } })).status, 200)
  assert.deepEqual(calls.log, ['importSeed [{"dryRun":true}]', 'importSeed [{"dryRun":false}]'])
  for (const body of [{}, { dryRun: 'yes' }, undefined]) {
    const bad = await call(routes, 'POST /import', { body })
    assert.equal(bad.status, 400, JSON.stringify(body))
    assert.equal(errorOf(bad)?.field, 'dryRun')
  }
})

test('a real import with no phone is blocked: 422 missing-phone (D8)', async () => {
  const { routes } = await started({ importSeed: async () => ({ ok: false, error: { code: 'blocked', reason: 'missing-phone' } }) })
  const response = await call(routes, 'POST /import', { body: { dryRun: false } })
  assert.equal(response.status, 422)
  assert.equal(errorOf(response)?.message, 'missing-phone')
})
