import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ErrorBody, ModuleContext, ModuleRequest, ModuleResponse, RouteTable, Timers } from '@factotum/core'
import { sessionsConfigSchema } from './config.ts'
import { sessionsModule } from './server.ts'
import type { CreateEngine, EngineSetup, FilesQuery, FilesResult, LaunchResult, ServiceView, SessionEngine } from './types.ts'

/**
 * A double, not the real engine. Importing the real one from this directory is exactly
 * the dependency the whole design exists to avoid, and there is a grep that would
 * catch it.
 */
function fakeEngine(overrides: Partial<SessionEngine> = {}): SessionEngine {
  return {
    launch: async () => ({ outcome: 'started', sessionId: 'sid-1' }),
    reply: async () => ({ outcome: 'started', sessionId: 'sid-1' }),
    cancel: async () => undefined,
    answer: async () => ({ kind: 'unknown' }),
    inspect: async () => ({ kind: 'unknown' }),
    list: async (page) => ({ sessions: [], page: page.page, hasMore: false }),
    read: async () => ({ events: [], nextSeq: 0, state: 'finished' }),
    decide: async () => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'fine',
      },
    }),
    reconcile: async () => undefined,
    view: () => ({ sites: [], catalog: [] }),
    stop: async () => undefined,
    summary: async () => ({ kind: 'unknown' }),
    rename: async () => ({ outcome: 'unknown' }),
    archive: async () => ({ outcome: 'unknown' }),
    remove: async (ids) => ids.map((id) => ({ id, outcome: 'unknown' as const })),
    search: async () => [],
    projects: async () => ({ projects: [], shared: [], removed: [], registryError: undefined, skipped: [], file: '/state/projects.json', home: '/home', canRequest: false, categories: [] }),
    requestProject: async () => ({ outcome: 'invalid', reason: 'no' }),
    requestShared: async () => ({ outcome: 'invalid', reason: 'no' }),
    requestStatus: async () => ({ status: 'unknown' }),
    inspectGrant: async () => ({ kind: 'unknown' }),
    answerGrant: async () => ({ outcome: 'unknown' }),
    updateProject: async () => ({ outcome: 'unknown' }),
    setLayout: async () => ({ outcome: 'ok', removedSessions: 0 }),
    removeProject: async () => ({ outcome: 'unknown' }),
    removeHistory: async () => ({ outcome: 'unknown' }),
    removeShared: async () => ({ outcome: 'unknown' }),
    ...overrides,
  }
}

const timers: Timers = {
  setInterval: () => ({ [Symbol.dispose]: () => undefined }),
  setTimeout: () => ({ [Symbol.dispose]: () => undefined }),
}

function context(config: { sites: never[]; catalog: never[] }): ModuleContext<never> {
  return {
    config: config as never,
    stateDir: '/state/modules/sessions',
    env: 'dev',
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date('2026-09-15T00:00:00.000Z'),
    timers,
    notify: { canReach: () => false, send: async () => undefined },
  }
}

const EMPTY = { sites: [] as never[], catalog: [] as never[] }

function request(method: string, path: string, extra: Partial<ModuleRequest> = {}): ModuleRequest {
  return { method, path, params: {}, query: {}, body: undefined, ...extra }
}

async function call(table: RouteTable, key: string, req: ModuleRequest): Promise<ModuleResponse> {
  const handler = table[key]
  assert.notEqual(handler, undefined, `no route ${key}`)
  return await handler!(req)
}

/** Builds the module with a given engine and walks it through steps 8 and 12. */
async function started(engine: SessionEngine, hookUrl: () => string = () => 'http://host:7778') {
  let setup: EngineSetup | undefined
  const create: CreateEngine = async (given) => {
    setup = given
    return engine
  }
  const module = sessionsModule(create, hookUrl)
  const table = module.routes!(context(EMPTY))
  const handle = await module.start!(context(EMPTY))
  return { module, table, handle, setup: setup! }
}

// ---------------------------------------------------------------------------
// The contract's five parts
// ---------------------------------------------------------------------------

test('the module claims the id, the schema and a screen', () => {
  const module = sessionsModule(async () => fakeEngine(), () => 'http://host:7778')
  assert.equal(module.id, 'sessions')
  assert.notEqual(module.configSchema, undefined)
  assert.equal(module.nav?.label, 'Sessions')
})

test('routes() only composes functions — it touches no disk and cannot throw', () => {
  // Step 8 has no try/catch above it anywhere, which block A confirmed by executing
  // it: a plain Error here kills the daemon with a raw stack.
  const module = sessionsModule(
    async () => {
      throw new Error('a factory that would blow up')
    },
    () => {
      throw new Error('a thunk that would blow up')
    },
  )
  assert.doesNotThrow(() => module.routes!(context(EMPTY)))
})

test('start() builds the engine with the setup WHOLE, and reconciles before serving', async () => {
  let reconciled = 0
  const engine = fakeEngine({ reconcile: async () => void (reconciled += 1) })
  const { setup } = await started(engine)

  assert.deepEqual(Object.keys(setup).sort(), [
    'catalog',
    'hookUrl',
    'log',
    // How the engine tells the owner a turn ended. Half a wiring here is a turn that ends in
    // silence, and tsc would not say so: this list is what does.
    'notify',
    'now',
    // The permission boundary is the REGISTRY now, with the three things the folder rules need
    // around it (spec 2026-09-29, D1). Half of it arriving is half a boundary, and this list is
    // what catches that, which is why it is spelled out.
    'factotumRoot',
    'home',
    'installRoot',
    'registry',
    'stateDir',
    'timers',
    // The titler's settings (spec 2026-09-30, D9), from the module's one schema.
    'titles',
    // The ceiling of one upload, the module's one literal (spec 2026-10-01, D4).
    'uploadMaxBytes',
  ].sort())
  assert.equal(setup.stateDir, '/state/modules/sessions')
  // Three levels above `<root>/<env>/modules/sessions`; this fixture has no env level, so `/`.
  assert.equal(setup.factotumRoot, '/')
  assert.equal(setup.registry.file, '/state/modules/sessions/projects.json')
  assert.equal(reconciled, 1)
})

test('the hookUrl crosses as a THUNK, unevaluated, because at step 12 there is no answer yet', async () => {
  let asked = 0
  await started(fakeEngine(), () => {
    asked += 1
    return 'http://host:7778'
  })
  assert.equal(asked, 0)
})

test('stop() stops the engine, with no ceremony around the hole', async () => {
  let stopped = 0
  const { handle } = await started(fakeEngine({ stop: async () => void (stopped += 1) }))
  await handle.stop()
  assert.equal(stopped, 1)
})

// ---------------------------------------------------------------------------
// The hole, before step 13
// ---------------------------------------------------------------------------

test('before start(), every route answers 503 rather than reaching for an engine', async () => {
  const module = sessionsModule(async () => fakeEngine(), () => 'http://host:7778')
  const table = module.routes!(context(EMPTY))

  for (const key of Object.keys(table)) {
    const response = await call(table, key, request('GET', '/'))
    assert.equal(response.status, 503, `${key} should fail closed`)
  }
})

// ---------------------------------------------------------------------------
// Criterion 17 — the 409 carries the session id
// ---------------------------------------------------------------------------

test('a busy site answers 409 WITH the id of the session that has it', async () => {
  const { table } = await started(
    fakeEngine({ launch: async () => ({ outcome: 'busy', sessionId: 'the-live-one' }) }),
  )
  const response = await call(
    table,
    'POST /sessions',
    request('POST', '/sessions', { body: { siteId: 'a', entryId: 'free', text: 'x' } }),
  )

  assert.equal(response.status, 409)
  // Without the id the screen can say "busy" and nothing else — it cannot offer to go
  // there or to cancel it, which is the whole of the criterion.
  assert.deepEqual((response.body as { conflict: unknown }).conflict, { sessionId: 'the-live-one' })
  assert.equal((response.body as ErrorBody).error.code, 'conflict')
})

test('a stale site answers 409 with the freshness report, not a bare refusal', async () => {
  const freshness = { clean: false, behind: 2, dirtyFiles: ['a.ts'], remoteWarning: undefined }
  const { table } = await started(fakeEngine({ launch: async () => ({ outcome: 'stale', freshness }) }))
  const response = await call(
    table,
    'POST /sessions',
    request('POST', '/sessions', { body: { siteId: 'a', entryId: 'free', text: 'x' } }),
  )
  assert.equal(response.status, 409)
  assert.deepEqual((response.body as { freshness: unknown }).freshness, freshness)
  assert.equal((response.body as ErrorBody).error.code, 'conflict')
})

test('a refusal the owner has to read comes back as 400 WITH its reason', async () => {
  // Refusals travel as values rather than exceptions precisely so this message
  // survives: server.ts:117-119 replaces a module exception's message on purpose.
  const { table } = await started(
    fakeEngine({ launch: async () => ({ outcome: 'rejected', reason: 'no site "ghost" is declared' }) }),
  )
  const response = await call(
    table,
    'POST /sessions',
    request('POST', '/sessions', { body: { siteId: 'ghost', entryId: 'free', text: 'x' } }),
  )
  assert.equal(response.status, 400)
  assert.match((response.body as { error: { message: string } }).error.message, /no site "ghost"/)
})

test('a launch missing its siteId or entryId is a 400, not a guess', async () => {
  const { table } = await started(fakeEngine())
  for (const body of [undefined, {}, { siteId: 'a' }, { entryId: 'free' }]) {
    const response = await call(table, 'POST /sessions', request('POST', '/sessions', { body }))
    assert.equal(response.status, 400)
  }
})

test('a reply with no text is a 400', async () => {
  const { table } = await started(fakeEngine())
  for (const body of [undefined, {}, { text: '' }]) {
    const response = await call(
      table,
      'POST /sessions/:id/reply',
      request('POST', '/sessions/x/reply', { params: { id: 'x' }, body }),
    )
    assert.equal(response.status, 400)
  }
})

test('a NUL in the text of a launch or a reply is a 400, and the engine never sees it', async () => {
  // The text becomes an argument of `claude`, and Node refuses an argument with a NUL by THROWING
  // inside `spawn` — by then `launch` has written a running meta with no process behind it.
  let reached = 0
  const { table } = await started(
    fakeEngine({
      launch: async () => {
        reached += 1
        return { outcome: 'started', sessionId: 'x' }
      },
      reply: async () => {
        reached += 1
        return { outcome: 'started', sessionId: 'x' }
      },
    }),
  )
  const launched = await call(table, 'POST /sessions', request('POST', '/sessions', { body: { siteId: 'a', entryId: 'free', text: 'a\u0000b' } }))
  const replied = await call(
    table,
    'POST /sessions/:id/reply',
    request('POST', '/sessions/x/reply', { params: { id: 'x' }, body: { text: 'a\u0000b' } }),
  )
  assert.equal(launched.status, 400)
  assert.equal(replied.status, 400)
  assert.match((launched.body as ErrorBody).error.message, /NUL/)
  assert.equal(reached, 0)
})

// ---------------------------------------------------------------------------
// The routes that just pass through
// ---------------------------------------------------------------------------

test('the cursor route passes fromSeq through, and copes with nonsense', async () => {
  const seen: number[] = []
  const { table } = await started(
    fakeEngine({
      read: async (_id, fromSeq) => {
        seen.push(fromSeq)
        return { events: [], nextSeq: fromSeq, state: 'running' }
      },
    }),
  )

  for (const value of ['7', 'not-a-number', undefined]) {
    await call(
      table,
      'GET /sessions/:id/events',
      request('GET', '/sessions/x/events', {
        params: { id: 'x' },
        query: value === undefined ? {} : { fromSeq: value },
      }),
    )
  }
  assert.deepEqual(seen, [7, 0, 0])
})

test('the list route passes the page through and copes with nonsense', async () => {
  const seen: number[] = []
  const { table } = await started(
    fakeEngine({
      list: async (page) => {
        seen.push(page.page)
        return { sessions: [], page: page.page, hasMore: false }
      },
    }),
  )
  for (const value of ['2', 'x', undefined]) {
    await call(table, 'GET /sessions', request('GET', '/sessions', { query: value === undefined ? {} : { page: value } }))
  }
  assert.deepEqual(seen, [2, 0, 0])
})

test('cancel is a POST, because adding a verb for one action is the growth to avoid', async () => {
  let cancelled: string | undefined
  const { table } = await started(fakeEngine({ cancel: async (id) => void (cancelled = id) }))
  const response = await call(
    table,
    'POST /sessions/:id/cancel',
    request('POST', '/sessions/abc/cancel', { params: { id: 'abc' } }),
  )
  assert.equal(response.status, 200)
  assert.equal(cancelled, 'abc')
  assert.equal(Object.keys(table).some((key) => key.startsWith('DELETE ')), false)
})

test('the setup route answers with what the screens need to draw the form', async () => {
  const view = { sites: [{ id: 'a', path: '/a', isRepo: true, name: 'A', color: 2 as const, status: 'ok' as const }], catalog: [] }
  const { table } = await started(fakeEngine({ view: () => view }))
  const response = await call(table, 'GET /setup', request('GET', '/setup'))
  assert.deepEqual(response.body, view)
})

// ---------------------------------------------------------------------------
// E4a — the handler's try/catch. Criterion 4.
// ---------------------------------------------------------------------------

test('a decider that THROWS becomes a 200 that says deny, never a 500', async () => {
  // Without the try/catch this leaves through registry.dispatch (registry.ts:255,
  // which does not catch) as a 500 module-error (server.ts:114-120) — and A 500
  // CARRIES NO DECISION. What the CLI does with one of those is the CLI's choice.
  const { table } = await started(
    fakeEngine({
      decide: async () => {
        throw new Error('the decider fell over')
      },
    }),
  )

  const response = await call(
    table,
    'POST /hooks/pre-tool-use',
    request('POST', '/hooks/pre-tool-use', { body: { anything: true } }),
  )

  assert.equal(response.status, 200)
  const body = response.body as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }
  assert.equal(body.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(body.hookSpecificOutput.permissionDecisionReason, /could not decide: the decider fell over/)
})

test('a decider that rejects with a non-Error still becomes a deny', async () => {
  const { table } = await started(fakeEngine({ decide: async () => { throw 'a bare string' } }))
  const response = await call(
    table,
    'POST /hooks/pre-tool-use',
    request('POST', '/hooks/pre-tool-use', { body: {} }),
  )
  assert.equal(response.status, 200)
  assert.equal(
    (response.body as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision,
    'deny',
  )
})

test('a decision the engine made travels through untouched', async () => {
  const decision = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: 'writes outside work: /etc/passwd',
    },
  }
  const { table } = await started(fakeEngine({ decide: async () => decision }))
  const response = await call(
    table,
    'POST /hooks/pre-tool-use',
    request('POST', '/hooks/pre-tool-use', { body: {} }),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, decision)
})

// ---------------------------------------------------------------------------
// The schema — form, and only form
// ---------------------------------------------------------------------------

test('an empty fragment is valid: a module that needs configuring to start is badly designed', () => {
  // `titles` comes out WITH its fields' defaults (spec 2026-09-30, crit. 30). With `.default({})` it
  // would come out `{}` — zod 4 does not parse a default — and tsc refuses that form anyway.
  assert.deepEqual(sessionsConfigSchema.parse({}), {
    sites: [],
    catalog: [],
    sharedPaths: [],
    titles: { enabled: true, model: 'haiku', effort: 'low' },
  })
  // Half a `titles` is filled in, not replaced.
  assert.deepEqual(sessionsConfigSchema.parse({ titles: { model: 'sonnet' } }).titles, { enabled: true, model: 'sonnet', effort: 'low' })
})

test('a malformed `titles` is refused by the schema, so it disables the module alone (2026-09-30 crit. 31)', () => {
  for (const titles of [{ effort: 'extreme' }, { model: '' }, { enabled: 'yes' }]) {
    assert.equal(sessionsConfigSchema.safeParse({ titles }).success, false, JSON.stringify(titles))
  }
})

test('a well-formed fragment parses', () => {
  const parsed = sessionsConfigSchema.parse({
    sites: [{ id: 'work', path: '/Users/x/work' }],
    catalog: [{ id: 'free', label: 'Free', invoke: { kind: 'none' } }],
  })
  assert.equal(parsed.sites[0]?.id, 'work')
  assert.equal(parsed.catalog[0]?.invoke.kind, 'none')
})

test('a RELATIVE site path is refused at step 6, before anything touches the disk', () => {
  const result = sessionsConfigSchema.safeParse({ sites: [{ id: 'work', path: 'relative/path' }] })
  assert.equal(result.success, false)
  assert.match(result.error?.issues[0]?.message ?? '', /must be absolute/)
})

test('a site path containing .. is refused', () => {
  const result = sessionsConfigSchema.safeParse({ sites: [{ id: 'work', path: '/a/../b' }] })
  assert.equal(result.success, false)
  assert.match(result.error?.issues[0]?.message ?? '', /must not contain/)
})

test('two sites with one id are refused — two directories cannot share one lock', () => {
  const result = sessionsConfigSchema.safeParse({
    sites: [{ id: 'work', path: '/a' }, { id: 'work', path: '/b' }],
  })
  assert.equal(result.success, false)
  assert.match(result.error?.issues[0]?.message ?? '', /same id/)
})

test('sharedPaths default to none, and hold the same shape rules as a site path', () => {
  // Same two refusals as `sites[].path`, from the same schema: a relative path would
  // be resolved against wherever the daemon was started, and `..` makes a boundary
  // nobody can read at a glance. A shared path is still a boundary.
  assert.deepEqual(sessionsConfigSchema.parse({}).sharedPaths, [])

  const ok = sessionsConfigSchema.parse({ sharedPaths: ['/Users/x/vault'] })
  assert.deepEqual(ok.sharedPaths, ['/Users/x/vault'])

  for (const bad of ['relative/vault', '/a/../b', '']) {
    assert.equal(sessionsConfigSchema.safeParse({ sharedPaths: [bad] }).success, false, bad)
  }
})

test('a site id shaped like a path is refused, because it names a lock FILE', () => {
  for (const id of ['../escape', 'has/slash', 'Has Capitals']) {
    assert.equal(sessionsConfigSchema.safeParse({ sites: [{ id, path: '/a' }] }).success, false)
  }
})

test('a catalog entry with an UNKNOWN kind still validates, so one bad row cannot sink the rest', () => {
  // Criterion 14. A stricter schema would fail the whole fragment and disable the
  // module; the per-entry judgement belongs where it can be made one at a time.
  const result = sessionsConfigSchema.safeParse({
    catalog: [
      { id: 'free', label: 'Free', invoke: { kind: 'none' } },
      { id: 'weird', label: 'Weird', invoke: { kind: 'skill-that-does-not-exist', name: 'x' } },
    ],
  })
  assert.equal(result.success, true)
  assert.equal(result.data?.catalog.length, 2)
})

test('the schema never THROWS, whatever it is given — safeParse does not catch that', () => {
  // boot.ts:55 calls composeModules with no try/catch, and safeParse catches a
  // validation failure but not an exception raised by the schema itself.
  for (const input of [undefined, null, 42, 'text', [], { sites: 'no' }, { catalog: 7 }]) {
    assert.doesNotThrow(() => sessionsConfigSchema.safeParse(input))
  }
})

// ---------------------------------------------------------------------------
// Answering an ask (spec criteria 20, 21, 46)
// ---------------------------------------------------------------------------

const answerRoute = 'POST /asks/:askId/answer'
const answering = (askId: string, body: unknown) =>
  request('POST', `/asks/${askId}/answer`, { params: { askId }, body })

test('an answer reaches the engine with the token and the decision, and says it was taken', async () => {
  const seen: [string, string][] = []
  const { table } = await started(
    fakeEngine({ answer: async (id, decision) => (seen.push([id, decision]), { kind: 'answered' }) }),
  )

  const response = await call(table, answerRoute, answering('tok', { decision: 'allow' }))

  assert.equal(response.status, 200)
  assert.deepEqual(seen, [['tok', 'allow']])
})

test('answering twice is 200, not an error — a service worker may retry (criterion 20)', async () => {
  const { table } = await started(fakeEngine({ answer: async () => ({ kind: 'already' }) }))
  assert.equal((await call(table, answerRoute, answering('tok', { decision: 'deny' }))).status, 200)
})

test('the answer says whether it was the FIRST one, so a repeat is not reported as "Allowed" (criterion 24)', async () => {
  const first = await started(fakeEngine({ answer: async () => ({ kind: 'answered' }) }))
  const again = await started(fakeEngine({ answer: async () => ({ kind: 'already' }) }))

  const a = await call(first.table, answerRoute, answering('tok', { decision: 'allow' }))
  const b = await call(again.table, answerRoute, answering('tok', { decision: 'allow' }))

  assert.deepEqual([a.status, a.body], [200, { answered: true, first: true }])
  assert.deepEqual([b.status, b.body], [200, { answered: true, first: false }])
})

// ---------------------------------------------------------------------------
// Reading an ask by its token (spec criterion 23)
// ---------------------------------------------------------------------------

const readRoute = 'GET /asks/:askId'
const reading = (askId: string) => request('GET', `/asks/${askId}`, { params: { askId } })
const NO_STORE = { 'cache-control': 'no-store' }

test('a pending ask reads as EXACTLY five fields, a null preview included, and is never cached', async () => {
  const seen: string[] = []
  const { table } = await started(
    fakeEngine({
      inspect: async (id) => (
        seen.push(id),
        { kind: 'pending', sessionId: 's1', toolName: 'Write', target: '/etc/hosts', preview: null, deadlineAt: '2026-09-19T11:00:00.000Z' }
      ),
    }),
  )

  const response = await call(table, readRoute, reading('tok'))

  assert.equal(response.status, 200)
  assert.deepEqual(seen, ['tok'])
  assert.deepEqual(JSON.parse(JSON.stringify(response.body)), {
    sessionId: 's1', toolName: 'Write', target: '/etc/hosts', preview: null, deadlineAt: '2026-09-19T11:00:00.000Z',
  })
  assert.deepEqual(response.headers, NO_STORE)
})

test('a settled ask is 409 conflict, and an unknown token 404 — both uncached', async () => {
  const settled = await started(fakeEngine({ inspect: async () => ({ kind: 'settled' }) }))
  const unknown = await started(fakeEngine({ inspect: async () => ({ kind: 'unknown' }) }))

  const a = await call(settled.table, readRoute, reading('tok'))
  const b = await call(unknown.table, readRoute, reading('tok'))

  assert.equal(a.status, 409)
  assert.equal((a.body as ErrorBody).error.code, 'conflict')
  assert.deepEqual(a.headers, NO_STORE)
  assert.equal(b.status, 404)
  assert.equal((b.body as ErrorBody).error.code, 'not-found')
  assert.deepEqual(b.headers, NO_STORE)
})

test('answering an ask that already expired is 409 with a reason a person can read (criterion 21)', async () => {
  const { table } = await started(fakeEngine({ answer: async () => ({ kind: 'expired' }) }))
  const response = await call(table, answerRoute, answering('tok', { decision: 'allow' }))

  assert.equal(response.status, 409)
  assert.match(JSON.stringify(response.body), /expired|too late/i)
  // THE CODE IS THE ONE THE KERNEL ADDED FOR 409s. `invalid-request` says "you called it
  // wrong", and the caller did not: the ask was valid and the clock ran out. A client that
  // branches on the code cannot tell a malformed body from a lost race otherwise.
  assert.equal((response.body as ErrorBody).error.code, 'conflict')
})

test('an unknown token is 404 — there is no default ask (criterion 46)', async () => {
  const { table } = await started(fakeEngine({ answer: async () => ({ kind: 'unknown' }) }))
  assert.equal((await call(table, answerRoute, answering('made-up', { decision: 'allow' }))).status, 404)
})

test('a decision that is neither allow nor deny is refused BEFORE reaching the engine', async () => {
  let called = 0
  const { table } = await started(fakeEngine({ answer: async () => (called++, { kind: 'answered' }) }))

  for (const body of [{ decision: 'yes' }, { decision: 'ask' }, {}, undefined]) {
    assert.equal((await call(table, answerRoute, answering('tok', body))).status, 400)
  }
  assert.equal(called, 0)
})

// ---------------------------------------------------------------------------
// The history routes (spec 2026-09-29, block E: criteria 32, 36, 40)
// ---------------------------------------------------------------------------

const SUMMARY = {
  id: '01a0eb02-9104-7cc7-bafc-259cf61fb313',
  siteId: 'work',
  entryId: 'free',
  state: 'finished' as const,
  startedAt: '2026-09-29T00:00:00.000Z',
  endedAt: undefined,
  reason: undefined,
  turns: 1,
  prompt: 'hi',
  title: undefined,
  autoTitle: undefined,
  archived: false,
}

test('EVERY LIST, SUMMARY AND EVENT PAGE IS no-store (criterion 40)', async () => {
  const { table } = await started(fakeEngine({ summary: async () => ({ kind: 'ok', summary: SUMMARY, project: undefined }) }))
  for (const [key, req] of [
    ['GET /projects', request('GET', '/projects')],
    ['GET /sessions', request('GET', '/sessions')],
    ['GET /sessions/:id', request('GET', `/sessions/${SUMMARY.id}`, { params: { id: SUMMARY.id } })],
    ['GET /sessions/:id/events', request('GET', `/sessions/${SUMMARY.id}/events`, { params: { id: SUMMARY.id } })],
    ['GET /setup', request('GET', '/setup')],
  ] as const) {
    const response = await call(table, key, req)
    assert.equal(response.status, 200, key)
    assert.equal(response.headers?.['cache-control'], 'no-store', key)
  }
})

test('GET /sessions reads site, page and archived, and refuses a site id that could not be one (criterion 11)', async () => {
  let asked: unknown
  const { table } = await started(fakeEngine({ list: async (page) => ((asked = page), { sessions: [], page: page.page, hasMore: false }) }))
  await call(table, 'GET /sessions', request('GET', '/sessions', { query: { site: 'web', page: '2', archived: 'true' } }))
  assert.deepEqual(asked, { page: 2, site: 'web', archived: true })
  const bad = await call(table, 'GET /sessions', request('GET', '/sessions', { query: { site: '../x' } }))
  assert.equal(bad.status, 400)
})

test('GET /sessions/:id: 200 with the project, 404, 400 and 409 with which project is missing (criteria 25, 36)', async () => {
  const outcomes = [
    [{ kind: 'ok', summary: SUMMARY, project: { id: 'work', name: 'Work', color: 2 } }, 200],
    [{ kind: 'unknown' }, 404],
    [{ kind: 'invalid' }, 400],
    [{ kind: 'site-missing', siteId: 'work' }, 409],
  ] as const
  for (const [result, status] of outcomes) {
    const { table } = await started(fakeEngine({ summary: async () => result }))
    const response = await call(table, 'GET /sessions/:id', request('GET', '/sessions/x', { params: { id: 'x' } }))
    assert.equal(response.status, status, result.kind)
    if (result.kind === 'site-missing') assert.deepEqual((response.body as { missing: unknown }).missing, { siteId: 'work' })
  }
})

test('the events of a conversation of a missing project are a 409; an invalid id a 400 (criteria 25, 32)', async () => {
  const missing = await started(fakeEngine({ read: async () => ({ kind: 'site-missing', siteId: 'work' }) }))
  const r1 = await call(missing.table, 'GET /sessions/:id/events', request('GET', '/sessions/x/events', { params: { id: 'x' } }))
  assert.equal(r1.status, 409)
  const invalidId = await started(fakeEngine({ read: async () => ({ kind: 'invalid' }) }))
  const r2 = await call(invalidId.table, 'GET /sessions/:id/events', request('GET', '/sessions/x/events', { params: { id: 'x' } }))
  assert.equal(r2.status, 400)
})

test('rename and archive: the body is checked here, the outcome mapped to 200, 400, 404 and 409 (criteria 30, 31)', async () => {
  const outcomes = [
    [{ outcome: 'ok', summary: SUMMARY }, 200],
    [{ outcome: 'unknown' }, 404],
    [{ outcome: 'running' }, 409],
    [{ outcome: 'invalid', reason: 'no' }, 400],
  ] as const
  for (const [result, status] of outcomes) {
    const { table } = await started(fakeEngine({ rename: async () => result, archive: async () => result }))
    const params = { id: SUMMARY.id }
    assert.equal((await call(table, 'POST /sessions/:id/title', request('POST', '/t', { params, body: { title: 'x' } }))).status, status)
    assert.equal((await call(table, 'POST /sessions/:id/archive', request('POST', '/a', { params, body: { archived: true } }))).status, status)
  }
  const { table } = await started(fakeEngine())
  // Empty text reaches the engine, which clears the owner's title (spec 2026-09-30, crit. 23). Only a
  // body that is not text is refused here.
  for (const body of [undefined, {}, { title: 3 }, { title: null }]) {
    assert.equal((await call(table, 'POST /sessions/:id/title', request('POST', '/t', { params: { id: 'x' }, body }))).status, 400)
  }
  let given: string | undefined
  const { table: clearing } = await started(fakeEngine({ rename: async (_id, title) => ((given = title), { outcome: 'ok', summary: SUMMARY }) }))
  assert.equal((await call(clearing, 'POST /sessions/:id/title', request('POST', '/t', { params: { id: 'x' }, body: { title: '  ' } }))).status, 200)
  assert.equal(given, '  ')
  assert.equal((await call(table, 'POST /sessions/:id/archive', request('POST', '/a', { params: { id: 'x' }, body: { archived: 'yes' } }))).status, 400)
})

test('delete several: at least one, at most 100, a result each (criterion 34)', async () => {
  const { table } = await started(fakeEngine())
  const ok = await call(table, 'POST /sessions/remove', request('POST', '/sessions/remove', { body: { ids: ['a', 'b'] } }))
  assert.equal(ok.status, 200)
  assert.deepEqual((ok.body as { results: unknown[] }).results.length, 2)
  for (const body of [{ ids: [] }, { ids: Array.from({ length: 101 }, (_, i) => String(i)) }, { ids: 'a' }, undefined]) {
    assert.equal((await call(table, 'POST /sessions/remove', request('POST', '/sessions/remove', { body }))).status, 400)
  }
})

// ---------------------------------------------------------------------------
// The projects routes (spec 2026-09-29, blocks C and D: criteria 8, 11, 17, 40)
// ---------------------------------------------------------------------------

test('THE 202 CARRIES NO TOKEN — whatever the engine hands back, only the request id and the deadline leave (criterion 8)', async () => {
  // An engine that, by some future mistake, put the token in its result. The route must not pass
  // it on: the whole approval rests on the token never leaving memory except in the push.
  const SECRET = 'S'.repeat(43)
  const leaky = { outcome: 'requested', requestId: 'req-1', expiresAt: '2026-09-29T10:10:00.000Z', token: SECRET } as const
  const { table } = await started(fakeEngine({ requestProject: async () => leaky, requestShared: async () => leaky }))
  for (const [key, body] of [
    ['POST /projects', { path: '/Users/me/web' }],
    ['POST /shared', { path: '/Users/me/notes' }],
  ] as const) {
    const response = await call(table, key, request('POST', '/', { body }))
    assert.equal(response.status, 202, key)
    assert.equal(JSON.stringify(response).includes(SECRET), false, `${key} leaked the token`)
    assert.deepEqual(response.body, { requestId: 'req-1', expiresAt: '2026-09-29T10:10:00.000Z' })
    assert.equal(response.headers?.['cache-control'], 'no-store')
  }
})

test('POST /projects checks the shape BEFORE the engine: relative, `..`, a bad id are 400 and the engine is never asked (criterion 11)', async () => {
  let asked = 0
  const { table } = await started(fakeEngine({ requestProject: async () => ((asked += 1), { outcome: 'invalid', reason: 'no' }) }))
  for (const body of [{ path: 'rel' }, { path: '/a/../b' }, { path: '/x', id: 'Bad' }, { path: '/x', color: 9 }]) {
    assert.equal((await call(table, 'POST /projects', request('POST', '/projects', { body }))).status, 400, JSON.stringify(body))
  }
  assert.equal(asked, 0)
})

test('the 409s of a request say which conflict, with the kernel’s codes untouched', async () => {
  const { table } = await started(fakeEngine({ requestProject: async () => ({ outcome: 'conflict', conflict: 'no-device', reason: 'subscribe one in Device' }) }))
  const response = await call(table, 'POST /projects', request('POST', '/projects', { body: { path: '/x' } }))
  assert.equal(response.status, 409)
  assert.deepEqual(response.body, { error: { code: 'conflict', message: 'subscribe one in Device' }, request: { conflict: 'no-device' } })
})

test('EVERY :id AND :siteId OF A PROJECT passes the site rule in the module: 400 and the engine is never asked (criterion 11)', async () => {
  let asked = 0
  const count = async () => ((asked += 1), { outcome: 'unknown' as const })
  const { table } = await started(fakeEngine({ updateProject: count, removeProject: count, removeHistory: count }))
  const bad = { id: '../x', siteId: 'A B' }
  assert.equal((await call(table, 'POST /projects/:id', request('POST', '/', { params: bad, body: {} }))).status, 400)
  assert.equal((await call(table, 'POST /projects/:id/remove', request('POST', '/', { params: bad }))).status, 400)
  assert.equal((await call(table, 'POST /projects/removed/:siteId/remove', request('POST', '/', { params: bad }))).status, 400)
  assert.equal(asked, 0)
})

test('changing and removing map to 200, 400, 404 and 409', async () => {
  const outcomes = [
    [{ outcome: 'ok', removedSessions: 3 }, 200],
    [{ outcome: 'unknown' }, 404],
    [{ outcome: 'conflict', reason: 'a session is running' }, 409],
    [{ outcome: 'invalid', reason: 'no' }, 400],
  ] as const
  for (const [result, status] of outcomes) {
    const both = async () => result
    const { table } = await started(fakeEngine({ updateProject: both, removeProject: both, removeHistory: both, removeShared: both }))
    const params = { id: 'web', siteId: 'demo' }
    assert.equal((await call(table, 'POST /projects/:id', request('POST', '/', { params, body: { name: 'W' } }))).status, status)
    assert.equal((await call(table, 'POST /projects/:id/remove', request('POST', '/', { params }))).status, status)
    assert.equal((await call(table, 'POST /projects/removed/:siteId/remove', request('POST', '/', { params }))).status, status)
    assert.equal((await call(table, 'POST /shared/remove', request('POST', '/', { body: { path: '/n' } }))).status, status)
  }
  const { table } = await started(fakeEngine())
  assert.equal((await call(table, 'POST /projects/:id', request('POST', '/', { params: { id: 'web' }, body: { color: 0 } }))).status, 400)
  assert.equal((await call(table, 'POST /shared/remove', request('POST', '/', { body: { path: 'rel' } }))).status, 400)
  assert.equal((await call(table, 'POST /shared', request('POST', '/', { body: {} }))).status, 400)
})

test('THE REQUEST STATUS by request id; the GRANT by its token, never cached (criteria 15, 17)', async () => {
  const { table } = await started(
    fakeEngine({
      requestStatus: async (id) => (id === 'req-1' ? { status: 'rejected', reason: 'inside the project "a"' } : { status: 'unknown' }),
      inspectGrant: async (token) =>
        token === 'live'
          ? { kind: 'pending', request: { kind: 'project', path: '/Users/me/web', id: 'web', name: undefined, color: 2 }, expiresAt: 'soon' }
          : token === 'old'
            ? { kind: 'settled' }
            : { kind: 'unknown' },
    }),
  )
  const status = await call(table, 'GET /projects/requests/:requestId', request('GET', '/', { params: { requestId: 'req-1' } }))
  assert.deepEqual([status.status, status.body], [200, { status: 'rejected', reason: 'inside the project "a"' }])
  assert.equal((await call(table, 'GET /projects/requests/:requestId', request('GET', '/', { params: { requestId: 'x' } }))).status, 404)

  const live = await call(table, 'GET /grants/:token', request('GET', '/', { params: { token: 'live' } }))
  assert.equal(live.status, 200)
  assert.equal(live.headers?.['cache-control'], 'no-store')
  assert.equal((live.body as { path: string }).path, '/Users/me/web')
  assert.equal((await call(table, 'GET /grants/:token', request('GET', '/', { params: { token: 'old' } }))).status, 409)
  const unknown = await call(table, 'GET /grants/:token', request('GET', '/', { params: { token: 'x' } }))
  assert.equal(unknown.status, 404)
  assert.equal(unknown.headers?.['cache-control'], 'no-store')
})

test('answering a grant: 200 with first and outcome, 404 unknown, 409 expired, 400 for anything but allow or deny', async () => {
  const outcomes = [
    [{ outcome: 'approved', reason: undefined, first: true }, 200],
    [{ outcome: 'unknown' }, 404],
    [{ outcome: 'expired' }, 409],
  ] as const
  for (const [result, status] of outcomes) {
    const { table } = await started(fakeEngine({ answerGrant: async () => result }))
    const response = await call(table, 'POST /grants/:token/answer', request('POST', '/', { params: { token: 't' }, body: { decision: 'allow' } }))
    assert.equal(response.status, status)
  }
  const { table } = await started(fakeEngine())
  assert.equal((await call(table, 'POST /grants/:token/answer', request('POST', '/', { params: { token: 't' }, body: { decision: 'maybe' } }))).status, 400)
})

test('GET /search: at least two characters, hits under no-store (criteria 38, 40)', async () => {
  let asked = ''
  const { table } = await started(fakeEngine({ search: async (q) => ((asked = q), []) }))
  const ok = await call(table, 'GET /search', request('GET', '/search', { query: { q: '  parser ' } }))
  assert.deepEqual([ok.status, ok.body, ok.headers?.['cache-control'], asked], [200, { hits: [] }, 'no-store', 'parser'])
  assert.equal((await call(table, 'GET /search', request('GET', '/search', { query: { q: 'p' } }))).status, 400)
})

// ---------------------------------------------------------------------------
// Attaching (spec 2026-10-01, D9)
// ---------------------------------------------------------------------------

const RECEIVED = { path: '/state/modules/sessions/.incoming/x.part', bytes: 12 }

test('POST /uploads is an upload route with the module ceiling, and passes that ceiling to the engine', async () => {
  const { table, setup } = await started(fakeEngine())
  const route = table['POST /uploads'] as (RouteTable[string] & { upload?: { maxBytes: number } }) | undefined
  assert.equal(route?.upload?.maxBytes, 20 * 1024 * 1024)
  assert.equal(setup.uploadMaxBytes, 20 * 1024 * 1024)
})

test('POST /uploads: without the file or without ?name= is a 400 and the engine is not asked', async () => {
  let asked = 0
  const { table } = await started(fakeEngine({ upload: async () => ((asked += 1), { outcome: 'invalid', reason: 'x' }) }))
  assert.equal((await call(table, 'POST /uploads', request('POST', '/uploads', { query: { name: 'a.png' } }))).status, 400)
  assert.equal((await call(table, 'POST /uploads', request('POST', '/uploads', { file: RECEIVED }))).status, 400)
  assert.equal(asked, 0)
})

test('POST /uploads: kept is 201 with its five fields, never cached', async () => {
  let got: { path: string; name: string } | undefined
  const { table } = await started(
    fakeEngine({
      upload: async (file, name) => {
        got = { path: file.path, name }
        return { outcome: 'ok', uploadId: '019a0000-0000-7000-8000-000000000001', name: 'a-b.png', path: '/state/uploads/019a/a-b.png', bytes: 12, image: true }
      },
    }),
  )
  const response = await call(table, 'POST /uploads', request('POST', '/uploads', { file: RECEIVED, query: { name: 'a b.png' } }))
  assert.equal(response.status, 201)
  assert.equal(response.headers?.['cache-control'], 'no-store')
  assert.deepEqual(response.body, { uploadId: '019a0000-0000-7000-8000-000000000001', name: 'a-b.png', path: '/state/uploads/019a/a-b.png', bytes: 12, image: true })
  assert.deepEqual(got, { path: RECEIVED.path, name: 'a b.png' })
})

test('POST /uploads: a name the engine refuses is 400; uploads off is a 409 that says why', async () => {
  const refused = await started(fakeEngine({ upload: async () => ({ outcome: 'invalid', reason: 'a file name cannot contain a slash' }) }))
  const bad = await call(refused.table, 'POST /uploads', request('POST', '/uploads', { file: RECEIVED, query: { name: 'a/b.png' } }))
  assert.equal(bad.status, 400)
  assert.match((bad.body as ErrorBody).error.message, /slash/)

  const off = await started(fakeEngine({ upload: async () => ({ outcome: 'off', reason: 'spaces in the state folder' }) }))
  const response = await call(off.table, 'POST /uploads', request('POST', '/uploads', { file: RECEIVED, query: { name: 'a.png' } }))
  assert.equal(response.status, 409)
  assert.equal((response.body as ErrorBody).error.code, 'conflict')
  assert.deepEqual((response.body as { uploads: unknown }).uploads, { off: 'spaces in the state folder' })
})

test('an engine without the upload members (a stale copy) answers 503, not a crash', async () => {
  const { table } = await started(fakeEngine())
  assert.equal((await call(table, 'POST /uploads', request('POST', '/uploads', { file: RECEIVED, query: { name: 'a.png' } }))).status, 503)
  assert.equal((await call(table, 'GET /uploads/:uploadId/:name', request('GET', '/uploads/x/y', { params: { uploadId: 'x', name: 'y' } }))).status, 503)
})

test('GET /uploads/:uploadId/:name answers with the FILE for a good one and 400 for a bad form (criterion 13)', async () => {
  const { table } = await started(
    fakeEngine({
      openUpload: (uploadId, name) => (uploadId === 'good' && name === 'a.png' ? { kind: 'ok', path: '/state/uploads/good/a.png' } : { kind: 'invalid' }),
    }),
  )
  const good = await call(table, 'GET /uploads/:uploadId/:name', request('GET', '/uploads/good/a.png', { params: { uploadId: 'good', name: 'a.png' } }))
  assert.deepEqual(good, { status: 200, file: '/state/uploads/good/a.png' })
  const bad = await call(table, 'GET /uploads/:uploadId/:name', request('GET', '/uploads/../x', { params: { uploadId: '..', name: 'x' } }))
  assert.equal(bad.status, 400)
})

test('POST /project-layout: the shape is checked HERE, the engine gets it clean, and its outcome maps to 200, 400 and 409', async () => {
  const seen: unknown[] = []
  const { table } = await started(
    fakeEngine({
      setLayout: async (layout) => {
        seen.push(layout)
        return { outcome: 'ok', removedSessions: 0 }
      },
    }),
  )
  const ok = await call(table, 'POST /project-layout', request('POST', '/', { body: { categories: [{ id: 'work', name: ' Work ' }], order: [{ id: 'web', category: 'work' }] } }))
  assert.equal(ok.status, 200)
  assert.equal(ok.headers?.['cache-control'], 'no-store')
  assert.deepEqual(seen, [{ categories: [{ id: 'work', name: 'Work' }], order: [{ id: 'web', category: 'work' }] }])

  const bad = await call(table, 'POST /project-layout', request('POST', '/', { body: { categories: [], order: [{ id: 'web', category: 'ghost' }] } }))
  assert.equal(bad.status, 400)
  assert.equal(seen.length, 1, 'a bad shape never reaches the engine')

  // STALE is a 409 with the kernel's `conflict` code: the screen reloads and tries again.
  const stale = async () => ({ outcome: 'conflict' as const, reason: 'the projects changed since this screen read them; reload and try again' })
  const { table: other } = await started(fakeEngine({ setLayout: stale }))
  const refused = await call(other, 'POST /project-layout', request('POST', '/', { body: { categories: [], order: [] } }))
  assert.equal(refused.status, 409)
  assert.equal((refused.body as ErrorBody).error.code, 'conflict')
})

// ---------------------------------------------------------------------------
// GET /files (spec 2026-10-01-referencias-y-tab, D6; criteria 7, 13–16)
// ---------------------------------------------------------------------------

const LISTING = {
  root: { kind: 'site' as const, path: '/work' },
  dir: '/work',
  entries: [{ name: 'src', kind: 'dir' as const }],
  shared: [],
  more: 0,
  partial: false,
}

test('GET /files answers each outcome with its status, and never lets it be cached (criteria 13–16)', async () => {
  const cases: readonly [FilesResult, number][] = [
    [{ outcome: 'ok', listing: LISTING }, 200],
    [{ outcome: 'unknown' }, 404],
    [{ outcome: 'missing', siteId: 'work' }, 409],
    [{ outcome: 'outside' }, 404],
    [{ outcome: 'unreadable', reason: 'cannot read that folder' }, 409],
    [{ outcome: 'timeout' }, 409],
  ]
  for (const [result, status] of cases) {
    const { table } = await started(fakeEngine({ files: async () => result }))
    const res = await call(table, 'GET /files', request('GET', '/files', { query: { site: 'work' } }))
    assert.equal(res.status, status, result.outcome)
    assert.equal(res.headers?.['cache-control'], 'no-store', result.outcome)
  }
})

test('GET /files says which 409 it is', async () => {
  const body = async (result: FilesResult) => {
    const { table } = await started(fakeEngine({ files: async () => result }))
    return (await call(table, 'GET /files', request('GET', '/files', { query: { site: 'work' } }))).body as Record<string, unknown>
  }
  assert.deepEqual((await body({ outcome: 'missing', siteId: 'work' }))['missing'], { siteId: 'work' })
  assert.deepEqual((await body({ outcome: 'unreadable', reason: 'x' }))['files'], { unreadable: true })
  assert.deepEqual((await body({ outcome: 'timeout' }))['files'], { timeout: true })
  assert.deepEqual(await body({ outcome: 'ok', listing: LISTING }), LISTING)
})

test('GET /files hands the engine the query it checked', async () => {
  let seen: FilesQuery | undefined
  const { table } = await started(
    fakeEngine({
      files: async (query) => {
        seen = query
        return { outcome: 'outside' }
      },
    }),
  )
  await call(table, 'GET /files', request('GET', '/files', { query: { site: 'work', dir: '/work/src', prefix: 'ap' } }))
  assert.deepEqual(seen, { siteId: 'work', dir: '/work/src', prefix: 'ap' })
  await call(table, 'GET /files', request('GET', '/files', { query: { site: 'work' } }))
  assert.deepEqual(seen, { siteId: 'work', dir: undefined, prefix: '' })
})

test('GET /files refuses a malformed query before the engine sees it (criteria 7, 13)', async () => {
  let calls = 0
  const { table } = await started(
    fakeEngine({
      files: async () => {
        calls += 1
        return { outcome: 'outside' }
      },
    }),
  )
  const bad: Readonly<Record<string, string>>[] = [
    {},
    { site: 'Not An Id' },
    { site: 'work', dir: '' },
    { site: 'work', dir: 'relative/path' },
    { site: 'work', dir: '/work/../etc' },
    { site: 'work', dir: '/work/./src' },
    { site: 'work', dir: '/work//src' },
    { site: 'work', dir: '/work/src/' },
    { site: 'work', dir: '/work/s\u0000rc' },
    { site: 'work', prefix: 'a/b' },
    { site: 'work', prefix: 'x'.repeat(256) },
  ]
  for (const query of bad) {
    const res = await call(table, 'GET /files', request('GET', '/files', { query }))
    assert.equal(res.status, 400, JSON.stringify(query))
    assert.equal(res.headers?.['cache-control'], 'no-store')
  }
  assert.equal(calls, 0)
})

test('GET /files on an engine copy without `files` is STARTING, and still not cached (criterion 16)', async () => {
  const { table } = await started(fakeEngine())
  const res = await call(table, 'GET /files', request('GET', '/files', { query: { site: 'work' } }))
  assert.equal(res.status, 503)
  assert.equal(res.headers?.['cache-control'], 'no-store')
})

// ---------------------------------------------------------------------------
// Questions (spec 2026-10-01-preguntas-con-opciones, D8; criteria 5, 13, 14, 15)
// ---------------------------------------------------------------------------

const mcpRoute = 'POST /mcp/:sessionId'
const mcpCall = (sessionId: string, body: unknown) => request('POST', `/mcp/${sessionId}`, { params: { sessionId }, body })

test('POST /mcp hands the session and the message to the engine, and forwards its body', async () => {
  const seen: unknown[] = []
  const engine = fakeEngine({
    mcp: async (sessionId, message) => {
      seen.push([sessionId, message])
      return { kind: 'body', body: { jsonrpc: '2.0', id: 1, result: { ok: true } } }
    },
  })
  const { table } = await started(engine)
  const res = await call(table, mcpRoute, mcpCall('sid-9', { jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { jsonrpc: '2.0', id: 1, result: { ok: true } })
  assert.deepEqual(seen, [['sid-9', { jsonrpc: '2.0', id: 1, method: 'tools/list' }]])
})

test('a notification is a 202 with no body (criterion 5)', async () => {
  const { table } = await started(fakeEngine({ mcp: async () => ({ kind: 'accepted' }) }))
  const res = await call(table, mcpRoute, mcpCall('s', { jsonrpc: '2.0', method: 'notifications/initialized' }))
  assert.equal(res.status, 202)
  assert.equal(res.body, undefined)
})

test('an engine that throws gives an isError result with the request id, never a 500; a notification, 202', async () => {
  const { table } = await started(
    fakeEngine({
      mcp: async () => {
        throw new Error('boom')
      },
    }),
  )
  const res = await call(table, mcpRoute, mcpCall('s', { jsonrpc: '2.0', id: 'abc', method: 'tools/call' }))
  assert.equal(res.status, 200)
  const body = res.body as { id: unknown; result: { isError: boolean; content: { text: string }[] } }
  assert.equal(body.id, 'abc')
  assert.equal(body.result.isError, true)
  assert.match(body.result.content[0]?.text ?? '', /boom/)
  const note = await call(table, mcpRoute, mcpCall('s', { jsonrpc: '2.0', method: 'x' }))
  assert.equal(note.status, 202)
})

test('an engine without mcp still answers the CLI something it can read', async () => {
  const { table } = await started(fakeEngine())
  const res = await call(table, mcpRoute, mcpCall('s', { jsonrpc: '2.0', id: 3, method: 'tools/call' }))
  assert.equal(res.status, 200)
  assert.equal((res.body as { result: { isError: boolean } }).result.isError, true)
})

const questionsRead = 'GET /questions/:token'
const questionsAnswer = 'POST /questions/:token/answer'
const readQuestions = (token: string) => request('GET', `/questions/${token}`, { params: { token } })
const answerQuestions = (token: string, body: unknown) => request('POST', `/questions/${token}/answer`, { params: { token }, body })

const pendingBatch = {
  kind: 'pending' as const,
  sessionId: 'sid-1',
  siteId: 'demo',
  id: 'b1',
  questions: [{ id: 'q1', text: 'Which?', options: [{ id: 'o1', label: 'a' }, { id: 'o2', label: 'b' }], multiple: false }],
  task: undefined,
  deadlineAt: '2026-10-01T01:00:00.000Z',
}

test('GET /questions/:token: 200 with the whole batch, never cached; 409 with how; 404', async () => {
  const answers: Record<string, Awaited<ReturnType<NonNullable<SessionEngine['inspectQuestions']>>>> = {
    live: pendingBatch,
    gone: { kind: 'over', how: 'expired' },
  }
  const { table } = await started(fakeEngine({ inspectQuestions: async (token) => answers[token] ?? { kind: 'unknown' } }))

  const live = await call(table, questionsRead, readQuestions('live'))
  assert.equal(live.status, 200)
  assert.equal(live.headers?.['cache-control'], 'no-store')
  assert.deepEqual(live.body, {
    sessionId: 'sid-1',
    siteId: 'demo',
    id: 'b1',
    questions: pendingBatch.questions,
    task: null,
    deadlineAt: '2026-10-01T01:00:00.000Z',
  })

  const gone = await call(table, questionsRead, readQuestions('gone'))
  assert.equal(gone.status, 409)
  assert.equal((gone.body as { how: string }).how, 'expired')

  const unknown = await call(table, questionsRead, readQuestions('nope'))
  assert.equal(unknown.status, 404)
})

test('POST /questions/:token/answer: 200 first, 400 invalid, 409 over, 404 (criteria 13, 14, 15)', async () => {
  const seen: unknown[] = []
  const results: Record<string, Awaited<ReturnType<NonNullable<SessionEngine['answerQuestions']>>>> = {
    fresh: { kind: 'answered', first: true },
    again: { kind: 'answered', first: false },
    bad: { kind: 'invalid', reason: '"zz" is not an option of "Which?".' },
    cancelled: { kind: 'over', how: 'cancelled' },
    expired: { kind: 'over', how: 'expired' },
  }
  const { table } = await started(
    fakeEngine({
      answerQuestions: async (token, body) => {
        seen.push([token, body])
        return results[token] ?? { kind: 'unknown' }
      },
    }),
  )

  const body = { answers: [{ question: 'q1', kind: 'none' }] }
  const fresh = await call(table, questionsAnswer, answerQuestions('fresh', body))
  assert.deepEqual([fresh.status, fresh.body], [200, { answered: true, first: true }])
  assert.deepEqual(seen[0], ['fresh', body])
  const again = await call(table, questionsAnswer, answerQuestions('again', body))
  assert.deepEqual([again.status, again.body], [200, { answered: true, first: false }])

  const bad = await call(table, questionsAnswer, answerQuestions('bad', body))
  assert.equal(bad.status, 400)
  assert.match((bad.body as ErrorBody).error.message, /not an option/)

  const cancelled = await call(table, questionsAnswer, answerQuestions('cancelled', body))
  assert.equal(cancelled.status, 409)
  assert.equal((cancelled.body as { how: string }).how, 'cancelled')
  assert.match((cancelled.body as ErrorBody).error.message, /cancelled/)
  const expired = await call(table, questionsAnswer, answerQuestions('expired', body))
  assert.match((expired.body as ErrorBody).error.message, /expired/)

  assert.equal((await call(table, questionsAnswer, answerQuestions('nope', body))).status, 404)
})

test('an engine without the questions members answers STARTING on /questions', async () => {
  const { table } = await started(fakeEngine())
  assert.equal((await call(table, questionsRead, readQuestions('t'))).status, 503)
  assert.equal((await call(table, questionsAnswer, answerQuestions('t', {}))).status, 503)
})

// From the screen, without a token (2026-10-02)
const sessionQuestionsRoute = 'GET /sessions/:id/questions'
const sessionAnswerRoute = 'POST /sessions/:id/questions/:batch/answer'

test('GET /sessions/:id/questions lists the open batches field by field, never cached; no engine member, STARTING', async () => {
  const batch = { id: 'b1', siteId: 'demo', questions: pendingBatch.questions, task: undefined, deadlineAt: 'd', token: 'MUST-NOT-LEAVE' }
  const { table } = await started(fakeEngine({ sessionQuestions: async (id) => (id === 'sid-1' ? [batch] : []) }))
  const res = await call(table, sessionQuestionsRoute, request('GET', '/sessions/sid-1/questions', { params: { id: 'sid-1' } }))
  assert.equal(res.status, 200)
  assert.equal(res.headers?.['cache-control'], 'no-store')
  assert.deepEqual(res.body, { batches: [{ id: 'b1', siteId: 'demo', questions: pendingBatch.questions, task: null, deadlineAt: 'd' }] })
  const bare = await started(fakeEngine())
  assert.equal((await call(bare.table, sessionQuestionsRoute, request('GET', '/sessions/x/questions', { params: { id: 'x' } }))).status, 503)
})

test('POST /sessions/:id/questions/:batch/answer reaches the engine with the session and the batch, and maps like the token route', async () => {
  const seen: unknown[] = []
  const { table } = await started(
    fakeEngine({
      answerSessionQuestions: async (id, batchId, body) => {
        seen.push([id, batchId, body])
        return batchId === 'b1' ? { kind: 'answered', first: true } : batchId === 'gone' ? { kind: 'over', how: 'expired' } : { kind: 'unknown' }
      },
    }),
  )
  const answer = (batch: string) => request('POST', `/sessions/sid-1/questions/${batch}/answer`, { params: { id: 'sid-1', batch }, body: { answers: [] } })
  const ok = await call(table, sessionAnswerRoute, answer('b1'))
  assert.deepEqual([ok.status, ok.body], [200, { answered: true, first: true }])
  assert.deepEqual(seen[0], ['sid-1', 'b1', { answers: [] }])
  const gone = await call(table, sessionAnswerRoute, answer('gone'))
  assert.equal(gone.status, 409)
  assert.equal((gone.body as { how: string }).how, 'expired')
  assert.equal((await call(table, sessionAnswerRoute, answer('nope'))).status, 404)
})

// ---------------------------------------------------------------------------
// Background services: the owner's two routes (spec 2026-10-02-servicios-en-segundo-plano, D13)
// ---------------------------------------------------------------------------

const serviceView: ServiceView = {
  id: 's1',
  command: 'python3 -m http.server 8765',
  description: undefined,
  cwd: '/work',
  pid: 4242,
  maxMinutes: 480,
  startedAt: '2026-10-02T12:00:00.000Z',
  task: undefined,
  state: 'exited',
  endedAt: '2026-10-02T12:05:00.000Z',
  by: undefined,
  code: 0,
  signal: undefined,
  reason: undefined,
}
const outputRoute = 'GET /sessions/:id/services/:serviceId/output'
const stopRoute = 'POST /sessions/:id/services/:serviceId/stop'
const readOutput = (lines?: string) =>
  request('GET', '/sessions/sid-1/services/s1/output', { params: { id: 'sid-1', serviceId: 's1' }, query: lines === undefined ? {} : { lines } })

test('GET …/output answers the view and the lines, also of one that ended, never cached (criterion 39)', async () => {
  const calls: unknown[][] = []
  const { table } = await started(fakeEngine({ readService: async (...args) => (calls.push(args), { view: serviceView, lines: ['GET / 200'] }) }))
  const res = await call(table, outputRoute, readOutput())
  assert.equal(res.status, 200)
  assert.equal(res.headers?.['cache-control'], 'no-store')
  assert.deepEqual(res.body, { view: serviceView, lines: ['GET / 200'] })
  assert.deepEqual(calls, [['sid-1', 's1', 50]])
  await call(table, outputRoute, readOutput('500'))
  assert.deepEqual(calls[1], ['sid-1', 's1', 200], 'over the ceiling is clipped')
})

test('GET …/output: lines that is not a positive integer is 400; a service that never existed there is 404', async () => {
  const { table } = await started(fakeEngine({ readService: async () => undefined }))
  for (const lines of ['0', '-3', 'ten', '2.5']) assert.equal((await call(table, outputRoute, readOutput(lines))).status, 400, lines)
  assert.equal((await call(table, outputRoute, readOutput())).status, 404)
})

test('POST …/stop answers the final view; 404 when there is no such service; never cached', async () => {
  const { table } = await started(fakeEngine({ stopService: async (_id, serviceId) => (serviceId === 's1' ? { ...serviceView, state: 'stopped', by: 'owner' } : undefined) }))
  const stop = (serviceId: string) => request('POST', `/sessions/sid-1/services/${serviceId}/stop`, { params: { id: 'sid-1', serviceId } })
  const res = await call(table, stopRoute, stop('s1'))
  assert.equal(res.status, 200)
  assert.equal(res.headers?.['cache-control'], 'no-store')
  assert.equal((res.body as ServiceView).state, 'stopped')
  assert.equal((await call(table, stopRoute, stop('s9'))).status, 404)
})

test('an engine without the services members answers like one still starting', async () => {
  const { table } = await started(fakeEngine())
  assert.equal((await call(table, outputRoute, readOutput())).status, 503)
})

test('the MCP fallbacks no longer talk about asking: they cover every tool (D13)', async () => {
  const withoutMcp = await started(fakeEngine())
  const none = await call(withoutMcp.table, mcpRoute, mcpCall('s', { jsonrpc: '2.0', id: 3, method: 'tools/call' }))
  assert.match((none.body as { result: { content: { text: string }[] } }).result.content[0]?.text ?? '', /factotum's tools are not available here/)
  const throwing = await started(fakeEngine({ mcp: async () => Promise.reject(new Error('boom')) }))
  const failed = await call(throwing.table, mcpRoute, mcpCall('s', { jsonrpc: '2.0', id: 3, method: 'tools/call' }))
  assert.match((failed.body as { result: { content: { text: string }[] } }).result.content[0]?.text ?? '', /factotum could not run the tool \(boom\)/)
})

// ---------------------------------------------------------------------------
// Dictation (spec 2026-10-03)
// ---------------------------------------------------------------------------

test('a broken dictation block does NOT cost the sessions: it starts, launches, and says why dictation is off (criterion 4)', async () => {
  const warnings: string[] = []
  const ctx = {
    ...context(EMPTY),
    config: { ...EMPTY, dictation: { apiKeyFile: 42 } } as never,
    log: { info: () => undefined, warn: (m: string) => void warnings.push(m), error: () => undefined },
  }
  const module = sessionsModule(async () => fakeEngine(), () => 'http://host:7778')
  const table = module.routes!(ctx)
  await module.start!(ctx)

  const launched = await call(table, 'POST /sessions', request('POST', 'sessions', { body: { siteId: 'a', entryId: 'b', text: 'hi' } }))
  assert.equal(launched.status, 200)
  assert.equal((launched.body as { sessionId: string }).sessionId, 'sid-1')
  const dictation = await call(table, 'GET /dictation', request('GET', 'dictation'))
  assert.equal(dictation.status, 200)
  assert.match((dictation.body as { off: string }).off, /apiKeyFile/)
  assert.equal(warnings.filter((w) => w.includes('dictation')).length, 1)
})

test('without a dictation block it is off, NOT_CONFIGURED; before start() it is 503 (criteria 5, 7)', async () => {
  const module = sessionsModule(async () => fakeEngine(), () => 'http://host:7778')
  const table = module.routes!(context(EMPTY))
  const before = await call(table, 'GET /dictation', request('GET', 'dictation'))
  assert.equal(before.status, 503)
  await module.start!(context(EMPTY))
  const after = await call(table, 'GET /dictation', request('GET', 'dictation'))
  assert.equal(after.status, 200)
  assert.match((after.body as { off: string }).off, /not configured/)
})
