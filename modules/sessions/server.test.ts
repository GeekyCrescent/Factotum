import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ErrorBody, ModuleContext, ModuleRequest, ModuleResponse, RouteTable, Timers } from '@factotum/core'
import { sessionsConfigSchema } from './config.ts'
import { sessionsModule } from './server.ts'
import type { CreateEngine, EngineSetup, LaunchResult, SessionEngine } from './types.ts'

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
    // The permission boundary is `sites` AND `sharedPaths`, so half of it arriving is
    // half a boundary. This list is what catches that, which is why it is spelled out.
    'sharedPaths',
    'sites',
    'stateDir',
    'timers',
  ])
  assert.equal(setup.stateDir, '/state/modules/sessions')
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
  const view = { sites: [{ id: 'a', path: '/a', isRepo: true }], catalog: [] }
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
  assert.deepEqual(sessionsConfigSchema.parse({}), { sites: [], catalog: [], sharedPaths: [] })
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
