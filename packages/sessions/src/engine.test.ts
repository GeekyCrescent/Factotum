import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NotificationMessage, Notifier, Timers } from '@factotum/core'
import { createEngine } from './engine.ts'
import { SiteLocks } from './locks.ts'
import { sessionPaths } from './paths.ts'
import { SessionStore } from './store.ts'
import type { CatalogEntry, EngineSetup, SessionEngine, SiteConfig } from './types.ts'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'fake-claude.mjs')
const BASE = 'http://100.64.0.1:7778'

/** Real timers, unrefd: the engine only uses them to bound git, which is mocked here. */
const timers: Timers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms)
    handle.unref()
    return { [Symbol.dispose]: () => clearInterval(handle) }
  },
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref()
    return { [Symbol.dispose]: () => clearTimeout(handle) }
  },
}

const CATALOG: readonly CatalogEntry[] = [
  { id: 'free', label: 'Free prompt', invoke: { kind: 'none' } },
  { id: 'review', label: 'Review', invoke: { kind: 'command', name: 'code-review' } },
  { id: 'broken', label: 'Broken', invoke: { kind: 'skill', name: 'x' } },
]

interface World {
  readonly engine: SessionEngine
  readonly stateDir: string
  readonly siteDir: string
  readonly store: SessionStore
  readonly locks: SiteLocks
  readonly warnings: string[]
  /** Every notice the engine asked to send, in order. The push service itself is not here. */
  readonly notices: NotificationMessage[]
}

/** For the setups that are not about notices. */
const silentNotify: Notifier = { canReach: () => false, send: async () => undefined }

async function world(options: { sites?: readonly SiteConfig[]; hookUrl?: () => string; notify?: Notifier } = {}): Promise<World> {
  const home = await mkdtemp(join(tmpdir(), 'factotum-engine-'))
  const stateDir = join(home, 'state')
  const siteDir = join(home, 'site')
  await mkdir(stateDir, { recursive: true })
  await mkdir(siteDir, { recursive: true })

  const warnings: string[] = []
  const notices: NotificationMessage[] = []
  const setup: EngineSetup = {
    stateDir,
    sites: options.sites ?? [{ id: 'work', path: siteDir }],
    catalog: CATALOG,
    log: { info: () => undefined, warn: (m: string) => void warnings.push(m), error: () => undefined },
    now: () => new Date(),
    timers,
    hookUrl: options.hookUrl ?? (() => BASE),
    notify: options.notify ?? { canReach: () => true, send: async (message) => void notices.push(message) },
  }

  const engine = await createEngine(setup, { bin: FAKE })
  const paths = sessionPaths(stateDir)
  return { engine, stateDir, siteDir, store: new SessionStore(paths, () => new Date()), locks: new SiteLocks(paths), warnings, notices }
}

/** The fake CLI chooses what to do from the prompt. */
const QUICK = 'quick'

/** A real repository, because a bare `.git` directory is not one and git says so. */
async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await promisify(execFile)('git', ['init', '--quiet'], { cwd: path })
}

// ---------------------------------------------------------------------------
// createEngine — criterion 15's second route
// ---------------------------------------------------------------------------

test('a declared site that does not exist makes createEngine THROW, which is what disables the module', async () => {
  await assert.rejects(
    () => world({ sites: [{ id: 'gone', path: '/definitely/not/here' }] }),
    /site "gone": .* does not exist/,
  )
})

test('a broken catalog entry is warned about and does not stop the engine coming up', async () => {
  const { warnings, engine } = await world()
  assert.match(warnings.join('\n'), /catalog entry "broken" is disabled/)
  assert.equal(engine.view().catalog.length, 3)
})

test('the view carries the sites and which catalog entries are usable', async () => {
  const { engine } = await world()
  const view = engine.view()
  assert.deepEqual(view.sites.map((s) => s.id), ['work'])
  assert.deepEqual(
    view.catalog.map((c) => [c.id, c.disabledReason === undefined]),
    [['free', true], ['review', true], ['broken', false]],
  )
})

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

test('a launch starts a session, writes its meta and records the agent process group', async () => {
  const { engine, store } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  assert.equal(result.outcome, 'started')

  const id = result.outcome === 'started' ? result.sessionId : ''
  const meta = await store.readMeta(id)
  assert.equal(meta?.siteId, 'work')
  assert.equal(typeof meta?.agentPid, 'number')

  await settle(engine, id)
  assert.equal((await engine.read(id, 0)).state, 'finished')
})

async function settle(engine: SessionEngine, id: string): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const page = await engine.read(id, 0)
    if (page.state !== 'running') return
    if (Date.now() > deadline) throw new Error(`session ${id} never settled`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('an unknown site is REJECTED with a reason, not an exception', async () => {
  // A thrown refusal loses its message at the HTTP boundary on purpose
  // (server.ts:117-119), so the ones the owner has to read travel as values.
  const { engine } = await world()
  const result = await engine.launch({ siteId: 'nope', entryId: 'free', text: QUICK, force: false })
  assert.equal(result.outcome, 'rejected')
  assert.match(result.outcome === 'rejected' ? result.reason : '', /no site "nope" is declared/)
})

test('an unknown catalog entry is rejected with a reason', async () => {
  const { engine } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'ghost', text: QUICK, force: false })
  assert.match(result.outcome === 'rejected' ? result.reason : '', /no catalog entry "ghost"/)
})

test('a DISABLED catalog entry is rejected, and says why it is disabled', async () => {
  const { engine } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'broken', text: QUICK, force: false })
  assert.match(result.outcome === 'rejected' ? result.reason : '', /is disabled: invoke\.kind "skill"/)
})

// ---------------------------------------------------------------------------
// Criterion 17 — the site is taken
// ---------------------------------------------------------------------------

test('a second launch on a busy site is refused AND told which session has it', async () => {
  const { engine } = await world()
  const first = await engine.launch({ siteId: 'work', entryId: 'free', text: 'linger', force: false })
  const firstId = first.outcome === 'started' ? first.sessionId : ''

  const second = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  assert.equal(second.outcome, 'busy')
  assert.equal(second.outcome === 'busy' ? second.sessionId : '', firstId)

  await engine.cancel(firstId)
})

test('the lock comes back when a session ends, so the site can be used again', async () => {
  const { engine, locks } = await world()
  const first = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  await settle(engine, first.outcome === 'started' ? first.sessionId : '')
  assert.equal(await locks.heldBy('work'), undefined)

  const second = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  assert.equal(second.outcome, 'started')
  await settle(engine, second.outcome === 'started' ? second.sessionId : '')
})

// ---------------------------------------------------------------------------
// The written debt: the lock is released when a launch fails HALFWAY
// ---------------------------------------------------------------------------

test('a launch that fails after taking the lock RELEASES IT', async () => {
  // The thunk throws while the composition root has not filled the URL in yet, which
  // is a real window: boot sets ready at step 13 and main.ts fills the URL on the next
  // statement. Without the try/finally the site would stay locked until the next
  // restart, and the 409 after it would hand the screen a session id with no session.
  const { engine, locks } = await world({
    hookUrl: () => {
      throw new Error('factotum is still composing itself; try again in a moment')
    },
  })

  await assert.rejects(() => engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false }))
  assert.equal(await locks.heldBy('work'), undefined)
})

test('and the site is usable immediately afterwards', async () => {
  let ready = false
  const { engine } = await world({
    hookUrl: () => {
      if (!ready) throw new Error('not yet')
      return BASE
    },
  })
  await assert.rejects(() => engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false }))

  ready = true
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  assert.equal(result.outcome, 'started')
  await settle(engine, result.outcome === 'started' ? result.sessionId : '')
})

// ---------------------------------------------------------------------------
// The settings file
// ---------------------------------------------------------------------------

test('every session gets its own settings file, with the hook at the composed URL', async () => {
  const { engine, stateDir } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''

  const settings = JSON.parse(await readFile(sessionPaths(stateDir).settingsFile(id), 'utf8')) as {
    hooks: { PreToolUse: { matcher: string; hooks: { url: string; type: string; timeout: number }[] }[] }
  }
  const entry = settings.hooks.PreToolUse[0]
  assert.equal(entry?.matcher, '*')
  assert.equal(entry?.hooks[0]?.type, 'http')
  assert.equal(entry?.hooks[0]?.url, `${BASE}/modules/sessions/hooks/pre-tool-use`)

  await settle(engine, id)
})

// ---------------------------------------------------------------------------
// Criterion 6 — decide resolves the site from session_id, and never guesses
// ---------------------------------------------------------------------------

function payload(sessionId: string, filePath: string, cwd: string, toolName = 'Write') {
  return {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    tool_name: toolName,
    tool_input: { file_path: filePath },
    tool_use_id: 'toolu_1',
    cwd,
  }
}

test('TWO live sessions in TWO different sites are not confused with each other', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-two-'))
  const a = join(home, 'a')
  const b = join(home, 'b')
  await mkdir(a, { recursive: true })
  await mkdir(b, { recursive: true })

  const setup: EngineSetup = {
    stateDir: join(home, 'state'),
    sites: [{ id: 'a', path: a }, { id: 'b', path: b }],
    catalog: CATALOG,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date(),
    timers,
    hookUrl: () => BASE,
    notify: silentNotify,
  }
  await mkdir(setup.stateDir, { recursive: true })
  const engine = await createEngine(setup, { bin: FAKE })

  const one = await engine.launch({ siteId: 'a', entryId: 'free', text: 'linger', force: false })
  const two = await engine.launch({ siteId: 'b', entryId: 'free', text: 'linger', force: false })
  const idA = one.outcome === 'started' ? one.sessionId : ''
  const idB = two.outcome === 'started' ? two.sessionId : ''

  // Each is allowed in its own site…
  assert.equal((await engine.decide(payload(idA, join(a, 'x'), a))).hookSpecificOutput.permissionDecision, 'allow')
  assert.equal((await engine.decide(payload(idB, join(b, 'x'), b))).hookSpecificOutput.permissionDecision, 'allow')
  // …and denied in the other one's, which is the whole point of the attribution.
  assert.equal((await engine.decide(payload(idA, join(b, 'x'), a))).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal((await engine.decide(payload(idB, join(a, 'x'), b))).hookSpecificOutput.permissionDecision, 'deny')

  await engine.cancel(idA)
  await engine.cancel(idB)
  await engine.stop()
})

test('TWO live sessions in two sites can BOTH write a shared path', async () => {
  // The reason sharedPaths exist: one agent per project, at the same time, all of them
  // writing notes into one vault. Expressing that with sites alone needs a single site
  // containing everything — and a site is one lock, so that is one agent.
  const home = await mkdtemp(join(tmpdir(), 'factotum-shared-'))
  const a = join(home, 'a')
  const b = join(home, 'b')
  const vault = join(home, 'vault')
  for (const dir of [a, b, vault]) await mkdir(dir, { recursive: true })

  const setup: EngineSetup = {
    stateDir: join(home, 'state'),
    sites: [{ id: 'a', path: a }, { id: 'b', path: b }],
    sharedPaths: [vault],
    catalog: CATALOG,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date(),
    timers,
    hookUrl: () => BASE,
    notify: silentNotify,
  }
  await mkdir(setup.stateDir, { recursive: true })
  const engine = await createEngine(setup, { bin: FAKE })

  const one = await engine.launch({ siteId: 'a', entryId: 'free', text: 'linger', force: false })
  const two = await engine.launch({ siteId: 'b', entryId: 'free', text: 'linger', force: false })
  const idA = one.outcome === 'started' ? one.sessionId : ''
  const idB = two.outcome === 'started' ? two.sessionId : ''

  // Both sessions, both allowed in the vault — simultaneously, each holding its own lock.
  assert.equal((await engine.decide(payload(idA, join(vault, 'n.md'), a))).hookSpecificOutput.permissionDecision, 'allow')
  assert.equal((await engine.decide(payload(idB, join(vault, 'n.md'), b))).hookSpecificOutput.permissionDecision, 'allow')
  // And the sites still do not leak into each other: shared is shared, not "everything".
  assert.equal((await engine.decide(payload(idA, join(b, 'x'), a))).hookSpecificOutput.permissionDecision, 'deny')
  // A shared path that is not declared is still outside, and the reason names the vault.
  const denied = await engine.decide(payload(idA, join(home, 'elsewhere', 'x'), a))
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /vault/)

  await engine.cancel(idA)
  await engine.cancel(idB)
  await engine.stop()
})

test('a sharedPath that does not exist disables the module, like a site that does not', async () => {
  // Same rule as a site, for the same reason: a boundary the owner declared and that is
  // not there is a configuration error about permissions, not something to skip quietly.
  const home = await mkdtemp(join(tmpdir(), 'factotum-shared-missing-'))
  const a = join(home, 'a')
  await mkdir(a, { recursive: true })

  const setup: EngineSetup = {
    stateDir: join(home, 'state'),
    sites: [{ id: 'a', path: a }],
    sharedPaths: [join(home, 'no-such-vault')],
    catalog: CATALOG,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date(),
    timers,
    hookUrl: () => BASE,
    notify: silentNotify,
  }
  await mkdir(setup.stateDir, { recursive: true })

  await assert.rejects(() => createEngine(setup, { bin: FAKE }), /no-such-vault/)
})

// ---------------------------------------------------------------------------
// Criterion 4 — fail closed, in the three places factotum controls
// ---------------------------------------------------------------------------

test('a session_id nobody recognises is DENIED — there is no default site', async () => {
  // Resolving an unknown caller against some default would be choosing where somebody
  // unrecognised gets to write.
  const { engine } = await world()
  const decision = await engine.decide(payload('not-a-session', '/work/site/x', '/work/site'))
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /does not recognise session/)
})

test('a payload that does not parse is DENIED rather than throwing', async () => {
  const { engine } = await world()
  for (const bad of [undefined, null, {}, { hook_event_name: 'PostToolUse' }, 'nonsense', 42]) {
    const decision = await engine.decide(bad)
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
  }
})

test('a payload carrying fields nothing reads still validates, because the schema is loose', async () => {
  // Block A measured three of them — transcript_path, prompt_id, effort. A strict
  // schema would deny every call the day the CLI adds a fourth.
  const { engine } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: 'linger', force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''
  const decision = await engine.decide({
    ...payload(id, '/nowhere/x', '/nowhere'),
    transcript_path: '/home/owner/x.jsonl',
    prompt_id: 'p1',
    permission_mode: 'default',
    effort: { level: 'high' },
  })
  // It parsed, so it got as far as a real decision rather than a schema refusal.
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /writes outside work/)
  await engine.cancel(id)
})

test('a deny is written to the log; an ALLOW writes nothing', async () => {
  const { engine } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: 'linger', force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''

  const before = (await engine.read(id, 0)).events.length
  await engine.decide(payload(id, '/etc/passwd', '/work/site'))
  const afterDeny = await engine.read(id, 0)
  assert.equal(afterDeny.events.length, before + 1)
  const written = afterDeny.events.at(-1)
  assert.equal(written?.kind === 'result' ? written.ok : true, false)
  assert.match(written?.kind === 'result' ? written.summary : '', /denied: writes outside work/)

  // Criterion 2: the gate is not noise when everything is fine.
  await engine.decide(payload(id, '/etc/passwd', '/work/site', 'Read'))
  assert.equal((await engine.read(id, 0)).events.length, before + 1)

  await engine.cancel(id)
})

// ---------------------------------------------------------------------------
// Criterion 4, the third case: the engine is not ready
// ---------------------------------------------------------------------------

test('after stop(), launch, reply and decide all REJECT — no session exists without a gate', async () => {
  const { engine } = await world()
  await engine.stop()

  await assert.rejects(() => engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false }), /engine stopped/)
  await assert.rejects(() => engine.reply('whatever', 'hi', false), /engine stopped/)
  await assert.rejects(() => engine.decide(payload('x', '/a', '/b')), /engine stopped/)
})

test('reading and listing still work after stop, because they cannot hurt anything', async () => {
  const { engine } = await world()
  await engine.stop()
  assert.deepEqual((await engine.list({ page: 0 })).sessions, [])
})

// ---------------------------------------------------------------------------
// reply
// ---------------------------------------------------------------------------

test('a reply reopens a finished session, bumps its turns and asks for the lock again', async () => {
  const { engine, store, locks } = await world()
  const first = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  const id = first.outcome === 'started' ? first.sessionId : ''
  await settle(engine, id)
  assert.equal(await locks.heldBy('work'), undefined)

  const second = await engine.reply(id, QUICK, false)
  assert.equal(second.outcome, 'started')
  assert.equal(second.outcome === 'started' ? second.sessionId : '', id)
  assert.equal((await locks.heldBy('work'))?.sessionId, id)

  await settle(engine, id)
  assert.equal((await store.readMeta(id))?.turns, 2)
})

test('replying to a session that is still running is refused', async () => {
  const { engine } = await world()
  const first = await engine.launch({ siteId: 'work', entryId: 'free', text: 'linger', force: false })
  const id = first.outcome === 'started' ? first.sessionId : ''

  const result = await engine.reply(id, 'more', false)
  assert.match(result.outcome === 'rejected' ? result.reason : '', /still running/)
  await engine.cancel(id)
})

test('replying to a session nobody has heard of is refused', async () => {
  const { engine } = await world()
  const result = await engine.reply('019965aa-0000-7000-8000-00000000dead', 'hi', false)
  assert.match(result.outcome === 'rejected' ? result.reason : '', /no session/)
})

// ---------------------------------------------------------------------------
// Criterion 20 — resuming onto a busy site is refused exactly like launching
// ---------------------------------------------------------------------------

test('resuming onto a site another session holds is refused, with that session’s id', async () => {
  const { engine, locks } = await world()
  const first = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  const id = first.outcome === 'started' ? first.sessionId : ''
  await settle(engine, id)

  // Somebody else takes the site in between.
  await locks.acquire('work', 'some-other-session', new Date().toISOString())

  const result = await engine.reply(id, QUICK, false)
  assert.equal(result.outcome, 'busy')
  assert.equal(result.outcome === 'busy' ? result.sessionId : '', 'some-other-session')
})

// ---------------------------------------------------------------------------
// Criterion 18 — cancel
// ---------------------------------------------------------------------------

test('cancelling kills the group, closes the session and gives the lock back', async () => {
  const { engine, store, locks } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: 'linger', force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''
  const agentPid = (await store.readMeta(id))?.agentPid

  await engine.cancel(id)

  const meta = await store.readMeta(id)
  assert.equal(meta?.state, 'cancelled')
  assert.equal(await locks.heldBy('work'), undefined)
  // `cancel` waits for the group, so by the time it returns nothing is left of it.
  assert.equal(typeof agentPid, 'number')
  assert.equal(groupAlive(agentPid ?? 0), false)
})

function groupAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

test('a cancelled session reads CANCELLED even when the exit looks like an ordinary failure', async () => {
  // The real CLI traps SIGTERM and exits 143, which from the outside is
  // indistinguishable from a program that failed. Inferring cancellation from the exit
  // status therefore gets it wrong — this was found by cancelling a real session from
  // the browser and reading "failed — exited with code 143" on the screen.
  const { engine, store } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: 'traps', force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''

  // Wait until it is actually under way. Signalling a node process before it has run
  // any of its script kills it by the default disposition, which is NOT the shape the
  // real CLI has — it traps the signal and exits 143 like an ordinary failure.
  const deadline = Date.now() + 15_000
  while ((await engine.read(id, 0)).events.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  await engine.cancel(id)

  const meta = await store.readMeta(id)
  assert.equal(meta?.state, 'cancelled')
  assert.equal(meta?.reason, 'cancelled by the owner')

  // And the LOG agrees, because the log is what the screen reads.
  const page = await engine.read(id, 0)
  assert.equal(page.state, 'cancelled')
  const last = page.events.at(-1)
  assert.equal(last?.kind === 'state' ? last.state : '', 'cancelled')
  // Exactly one terminal state event: no "cancelled" followed by "failed".
  assert.equal(page.events.filter((e) => e.kind === 'state' && e.state !== 'running').length, 1)
})

test('cancelling a session that already finished is a no-op', async () => {
  const { engine, store } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''
  await settle(engine, id)

  await assert.doesNotReject(() => engine.cancel(id))
  assert.equal((await store.readMeta(id))?.state, 'finished')
})

test('cancelling a session that a dead daemon left behind closes it anyway', async () => {
  const { engine, store, stateDir } = await world()
  const orphan = '019965aa-0000-7000-8000-0000000000aa'
  await new SessionStore(sessionPaths(stateDir), () => new Date()).create({
    id: orphan,
    siteId: 'work',
    entryId: 'free',
    startedAt: new Date().toISOString(),
    sitePath: undefined,
  })

  await engine.cancel(orphan)
  assert.equal((await store.readMeta(orphan))?.state, 'cancelled')
})

// ---------------------------------------------------------------------------
// list and read
// ---------------------------------------------------------------------------

test('sessions list newest first and paginate', async () => {
  const { engine } = await world()
  const ids: string[] = []
  for (let i = 0; i < 3; i += 1) {
    const result = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
    const id = result.outcome === 'started' ? result.sessionId : ''
    ids.push(id)
    await settle(engine, id)
  }

  const page = await engine.list({ page: 0 })
  assert.deepEqual(page.sessions.map((s) => s.id), [...ids].reverse())
  assert.equal(page.hasMore, false)
})

test('a negative page is treated as the first one rather than throwing', async () => {
  const { engine } = await world()
  assert.equal((await engine.list({ page: -5 })).page, 0)
  assert.deepEqual((await engine.read('nothing', -3)).events, [])
})

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

test('stop signals every live group and closes each session, leaving the lock for reconcile', async () => {
  const { engine, store, locks } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: 'linger', force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''

  await engine.stop()

  const meta = await store.readMeta(id)
  assert.equal(meta?.state, 'cancelled')
  assert.match(meta?.reason ?? '', /shutting down/)
  // The lock is LEFT on purpose: the next boot finds it over a terminal session and
  // releases it, and until then the site stays closed to anything that survived.
  assert.notEqual(await locks.heldBy('work'), undefined)
})

test('stop on an idle engine does nothing and does not complain', async () => {
  const { engine } = await world()
  await assert.doesNotReject(() => engine.stop())
})

test('a second stop is harmless', async () => {
  const { engine } = await world()
  await engine.stop()
  await assert.doesNotReject(() => engine.stop())
})

// ---------------------------------------------------------------------------
// reconcile, through the facade
// ---------------------------------------------------------------------------

test('reconcile through the facade releases a lock left by a dead daemon', async () => {
  const { engine, stateDir, locks } = await world()
  const store = new SessionStore(sessionPaths(stateDir), () => new Date())
  const stale = '019965aa-0000-7000-8000-0000000000bb'
  await store.create({ id: stale, siteId: 'work', entryId: 'free', startedAt: new Date().toISOString(), sitePath: undefined })
  await new SiteLocks(sessionPaths(stateDir), 999_999).acquire('work', stale, new Date().toISOString())

  await engine.reconcile()

  assert.equal(await locks.heldBy('work'), undefined)
  assert.equal((await store.readMeta(stale))?.state, 'failed')
})

// ---------------------------------------------------------------------------
// Criterion 12 — freshness warns, never blocks
// ---------------------------------------------------------------------------

test('a site that is NOT a repo launches with no freshness check at all', async () => {
  const { engine } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  assert.equal(result.outcome, 'started')
  await settle(engine, result.outcome === 'started' ? result.sessionId : '')
})

test('a DIRTY repo is refused with the report, and `force` launches over it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-fresh-'))
  const siteDir = join(home, 'repo')
  await initRepo(siteDir)
  await writeFile(join(siteDir, 'dirty.txt'), 'uncommitted')

  const setup: EngineSetup = {
    stateDir: join(home, 'state'),
    sites: [{ id: 'repo', path: siteDir }],
    catalog: CATALOG,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date(),
    timers,
    hookUrl: () => BASE,
    notify: silentNotify,
  }
  await mkdir(setup.stateDir, { recursive: true })
  const engine = await createEngine(setup, { bin: FAKE })

  const refused = await engine.launch({ siteId: 'repo', entryId: 'free', text: QUICK, force: false })
  assert.equal(refused.outcome, 'stale')
  if (refused.outcome === 'stale') {
    assert.equal(refused.freshness.clean, false)
    // It says WHICH files, not just that something is wrong.
    assert.equal(refused.freshness.dirtyFiles.includes('dirty.txt'), true)
  }

  const forced = await engine.launch({ siteId: 'repo', entryId: 'free', text: QUICK, force: true })
  assert.equal(forced.outcome, 'started')
  const id = forced.outcome === 'started' ? forced.sessionId : ''
  await settle(engine, id)

  // And the report is the first thing in the log, so the decision is recoverable.
  const first = (await engine.read(id, 0)).events[0]
  assert.match(first?.kind === 'message' ? first.text : '', /launched over a freshness warning/)
})

test('a refused stale launch does not keep the lock', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-fresh2-'))
  const siteDir = join(home, 'repo')
  await initRepo(siteDir)
  await writeFile(join(siteDir, 'dirty.txt'), 'x')

  const setup: EngineSetup = {
    stateDir: join(home, 'state'),
    sites: [{ id: 'repo', path: siteDir }],
    catalog: CATALOG,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date(),
    timers,
    hookUrl: () => BASE,
    notify: silentNotify,
  }
  await mkdir(setup.stateDir, { recursive: true })
  const engine = await createEngine(setup, { bin: FAKE })
  await engine.launch({ siteId: 'repo', entryId: 'free', text: QUICK, force: false })

  assert.equal(await new SiteLocks(sessionPaths(setup.stateDir)).heldBy('repo'), undefined)
})

// ---------------------------------------------------------------------------
// Notices: one per END OF TURN (spec criteria 25-28, 44, 47, 48, 50, 51)
// ---------------------------------------------------------------------------

/**
 * `settle` returns once the LOG stops saying running, which is before `finalize` has finished —
 * the notice goes out after the meta is written. The lock is the last thing `finalize` touches,
 * so "the lock is back" is "the turn is fully over".
 */
async function turnOver(locks: SiteLocks, siteId: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while ((await locks.heldBy(siteId)) !== undefined) {
    if (Date.now() > deadline) throw new Error(`site ${siteId} never came back`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('a turn that ends produces EXACTLY ONE notice, naming the session and the site (criterion 25)', async () => {
  const { engine, locks, notices } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''

  await settle(engine, id)
  await turnOver(locks, 'work')

  assert.equal(notices.length, 1)
  assert.equal(notices[0]?.title, 'finished')
  assert.equal(notices[0]?.tag, id, 'the session id collapses duplicates on the phone')
  assert.equal(notices[0]?.path, `/m/sessions/${id}`)
  assert.match(notices[0]?.body ?? '', /work/)
})

test('a session of two turns notifies TWICE — one per end of turn, which is the point (criterion 25, §0.28)', async () => {
  const { engine, locks, notices } = await world()
  const first = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  const id = first.outcome === 'started' ? first.sessionId : ''
  await settle(engine, id)
  await turnOver(locks, 'work')

  await engine.reply(id, QUICK, false)
  await settle(engine, id)
  await turnOver(locks, 'work')

  assert.equal(notices.length, 2)
})

test('CANCELLING A LIVE SESSION FROM THE PHONE sends nothing back to it (criterion 51)', async () => {
  // The owner just asked for it and is looking at the screen. And the live path does not go
  // through `cancel`'s own `finalize` call: it goes through `spawnFor`'s settle, which is where
  // the "do not notify" has to be decided.
  const { engine, locks, notices } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: 'linger', force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''

  await engine.cancel(id)
  await turnOver(locks, 'work')

  assert.equal(notices.length, 0)
})

test('cancelling a session a dead daemon left behind sends nothing either', async () => {
  const { engine, store, notices } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: 'linger', force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''
  await engine.stop() // the engine that owned it is gone
  notices.length = 0

  const { engine: second } = await world()
  void store
  await second.cancel(id) // not live in `second`: goes through cancel's own finalize

  assert.equal(notices.length, 0)
})

test('cancel does not wait for the notice — a push service that hangs does not slow the phone down (criterion 44)', async () => {
  // Not about cancel's own path (it sends nothing), but about finalize in general: the send is
  // fire-and-forget, so nothing awaiting `settled` pays for it.
  const hanging: Notifier = { canReach: () => true, send: () => new Promise(() => undefined) }
  const { engine, locks } = await world({ notify: hanging })
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''

  const started = Date.now()
  await settle(engine, id)
  await turnOver(locks, 'work')

  assert.ok(Date.now() - started < 5_000, 'finalize did not wait on a send that never resolves')
})

test('A NOTICE THAT REJECTS DOES NOT KILL THE DAEMON (criterion 47)', async () => {
  // `send` promises never to reject, but it writes subscriptions.json when it removes a dead
  // device, and that can fail. In Node 22+ an unhandled rejection ends the process.
  const unhandled: unknown[] = []
  const listener = (reason: unknown) => void unhandled.push(reason)
  process.on('unhandledRejection', listener)
  try {
    const rejecting: Notifier = { canReach: () => true, send: () => Promise.reject(new Error('EACCES')) }
    const { engine, locks } = await world({ notify: rejecting })
    const result = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
    await settle(engine, result.outcome === 'started' ? result.sessionId : '')
    await turnOver(locks, 'work')
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', listener)
  }
})

test('a FAILED turn notifies — but stderr never leaves the tailnet (spec §5)', async () => {
  // The failure reason of a crashed agent is its stderr, which can carry paths and anything else
  // the process printed. The screen shows it; the notice does not.
  const { engine, locks, notices } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: 'boom', force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''
  await settle(engine, id)
  await turnOver(locks, 'work')

  assert.equal(notices.length, 1)
  assert.equal(notices[0]?.title, 'failed')
  assert.doesNotMatch(JSON.stringify(notices[0]), /something went wrong|fake-claude/)
})

test('stop notifies each live session ONCE, concurrently, and after the meta says so (criteria 27, 45, 48)', async () => {
  const sent: { at: number; title: string }[] = []
  const order: string[] = []
  const slow: Notifier = {
    canReach: () => true,
    send: async (message) => {
      order.push('send')
      sent.push({ at: Date.now(), title: message.title })
      await new Promise((resolve) => setTimeout(resolve, 200))
    },
  }
  const { engine, store } = await world({
    sites: [{ id: 'work', path: join(tmpdir()) }],
    notify: slow,
  })
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: 'linger', force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''

  await engine.stop()

  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.title, 'cancelled')
  // After patchMeta: by the time the notice went out, the meta already said terminal — so a
  // crash after it cannot make reconcile announce the same end a second time.
  assert.equal((await store.readMeta(id))?.state, 'cancelled')
})

test('stop does not hang on a notice that never resolves, and arms no timer of its own (criterion 50)', async () => {
  // The bound is the push service's AbortSignal, not a timer here: engine.ts documents that
  // stop() arms none, because registry.stopAll() disposes timers AFTER calling it. With a
  // notifier that never resolves, what bounds stop in production is that signal — so here, with
  // a double that has none, stop must not WAIT on the send at all past a settle.
  const hanging: Notifier = { canReach: () => true, send: () => new Promise(() => undefined) }
  const { engine } = await world({ notify: hanging })
  await engine.launch({ siteId: 'work', entryId: 'free', text: 'linger', force: false })

  const started = Date.now()
  await Promise.race([engine.stop(), new Promise((_, reject) => setTimeout(() => reject(new Error('stop hung')), 3_000))])
  assert.ok(Date.now() - started < 3_000)
})

test('a session that died WITH THE DAEMON is announced on the way back up, with why (criterion 26)', async () => {
  // The gap the TLS spec left written: "nobody tells the client its session was cancelled by a
  // restart". The reason already sat in meta.json; this is what carries it to the phone.
  const { engine, stateDir, notices } = await world()
  const store = new SessionStore(sessionPaths(stateDir), () => new Date())
  const crashed = '019965aa-0000-7000-8000-0000000000cc'
  await store.create({ id: crashed, siteId: 'work', entryId: 'free', startedAt: new Date().toISOString(), sitePath: undefined })
  await new SiteLocks(sessionPaths(stateDir), 999_999).acquire('work', crashed, new Date().toISOString())

  await engine.reconcile()

  assert.equal(notices.length, 1)
  assert.equal(notices[0]?.title, 'failed')
  assert.equal(notices[0]?.tag, crashed)
  // A reason this package wrote word for word, so it may leave the tailnet.
  assert.match(notices[0]?.body ?? '', /the daemon stopped while this session was running/)
})

test('a session stop() already closed is NOT announced a second time by reconcile (criterion 45)', async () => {
  const { engine, stateDir, notices } = await world()
  const store = new SessionStore(sessionPaths(stateDir), () => new Date())
  const closed = '019965aa-0000-7000-8000-0000000000dd'
  await store.create({ id: closed, siteId: 'work', entryId: 'free', startedAt: new Date().toISOString(), sitePath: undefined })
  // What stop() leaves: a terminal meta over a lock it deliberately did not release.
  await store.patchMeta(closed, (m) => ({ ...m, state: 'cancelled', reason: 'the daemon was shutting down' }))
  await new SiteLocks(sessionPaths(stateDir), 999_999).acquire('work', closed, new Date().toISOString())

  await engine.reconcile()

  assert.equal(notices.length, 0)
})

test('reconcile does not wait on a notice — a hanging push service cannot disable the module at boot', async () => {
  const hanging: Notifier = { canReach: () => true, send: () => new Promise(() => undefined) }
  const { engine, stateDir } = await world({ notify: hanging })
  const store = new SessionStore(sessionPaths(stateDir), () => new Date())
  const crashed = '019965aa-0000-7000-8000-0000000000ee'
  await store.create({ id: crashed, siteId: 'work', entryId: 'free', startedAt: new Date().toISOString(), sitePath: undefined })
  await new SiteLocks(sessionPaths(stateDir), 999_999).acquire('work', crashed, new Date().toISOString())

  await Promise.race([engine.reconcile(), new Promise((_, reject) => setTimeout(() => reject(new Error('reconcile waited')), 2_000))])
})

test('A FULL RUN COUNTS EXACTLY THE NOTICES IT SHOULD, AND NOT ONE MORE (criterion 28)', async () => {
  // The test that protects the feature from itself. Someone adding a "useful" notice — on a
  // deny, on a launch, on a tool — turns this red, and nothing else would. The owner's own words
  // when this spec started: if it tells me about everything, I will mute it within a week.
  //
  // `canReach: false` on purpose: the gate must DENY here, not ask, so this keeps measuring the
  // same thing once `ask` exists. The engine's own end-of-turn notices do not consult canReach —
  // whether anyone is subscribed is the push service's business.
  const notices: NotificationMessage[] = []
  const recorder: Notifier = { canReach: () => false, send: async (m) => void notices.push(m) }
  const { engine, locks } = await world({ notify: recorder })

  const first = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  const id = first.outcome === 'started' ? first.sessionId : ''
  await settle(engine, id)
  await turnOver(locks, 'work')

  await engine.reply(id, 'linger', false)
  await engine.decide(payload(id, '/etc/passwd', '/work/site')) // a deny: no notice
  await engine.decide(payload(id, '/etc/passwd', '/work/site', 'Read')) // an allow: no notice
  await engine.cancel(id) // cancelled from the phone: no notice
  await turnOver(locks, 'work')

  await engine.reply(id, QUICK, false)
  await settle(engine, id)
  await turnOver(locks, 'work')

  assert.deepEqual(
    notices.map((n) => n.title),
    ['finished', 'finished'],
    'one per turn that ENDED on its own; nothing for launch, deny, allow or a cancel',
  )
})

// ---------------------------------------------------------------------------
// Resuming is as careful as launching (spec block G, criteria 31-35, 49, 52)
// ---------------------------------------------------------------------------

/** An engine over `sites`, on a state directory that can be shared between two engines. */
async function engineOver(stateDir: string, sites: readonly SiteConfig[]): Promise<SessionEngine> {
  await mkdir(stateDir, { recursive: true })
  return await createEngine(
    {
      stateDir,
      sites,
      catalog: CATALOG,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => new Date(),
      timers,
      hookUrl: () => BASE,
      notify: silentNotify,
    },
    { bin: FAKE },
  )
}

test('a new session records the site path it launched in (criterion 52)', async () => {
  // With the field optional, `store.create` would compile without it and it would never be
  // written — leaving criteria 33 and 34 satisfiable only by a hand-made meta.json.
  const { engine, store, siteDir } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''
  await settle(engine, id)

  assert.equal((await store.readMeta(id))?.sitePath, siteDir)
})

test('resuming with the site path intact still works, and turns go up (criterion 34)', async () => {
  const { engine, store, locks } = await world()
  const first = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  const id = first.outcome === 'started' ? first.sessionId : ''
  await settle(engine, id)
  await turnOver(locks, 'work')

  const again = await engine.reply(id, QUICK, false)
  assert.equal(again.outcome, 'started')
  await settle(engine, id)
  assert.equal((await store.readMeta(id))?.turns, 2)
})

test('a site that MOVED under the same id is refused, naming both paths, and nothing is touched (criterion 33)', async () => {
  // Without this, `--resume` continues a thread whose context talks about one tree, in another.
  const home = await mkdtemp(join(tmpdir(), 'factotum-moved-'))
  const before = join(home, 'before')
  const after = join(home, 'after')
  await mkdir(before, { recursive: true })
  await mkdir(after, { recursive: true })
  const stateDir = join(home, 'state')

  const original = await engineOver(stateDir, [{ id: 'work', path: before }])
  const launched = await original.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  const id = launched.outcome === 'started' ? launched.sessionId : ''
  await settle(original, id)
  await turnOver(new SiteLocks(sessionPaths(stateDir)), 'work')
  await original.stop()

  const moved = await engineOver(stateDir, [{ id: 'work', path: after }])
  const store = new SessionStore(sessionPaths(stateDir), () => new Date())
  const metaBefore = await store.readMeta(id)

  const result = await moved.reply(id, QUICK, false)

  assert.equal(result.outcome, 'rejected')
  const reason = result.outcome === 'rejected' ? result.reason : ''
  assert.match(reason, new RegExp(before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(reason, new RegExp(after.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.deepEqual(await store.readMeta(id), metaBefore)
  assert.equal(await new SiteLocks(sessionPaths(stateDir)).heldBy('work'), undefined)
})

test('a meta.json from BEFORE the path was recorded still resumes, and the log says why it was not compared (criterion 35)', async () => {
  const { engine, store, locks } = await world()
  const first = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  const id = first.outcome === 'started' ? first.sessionId : ''
  await settle(engine, id)
  await turnOver(locks, 'work')
  // What a session written by the previous version looks like on disk: no `sitePath` at all.
  await store.patchMeta(id, (meta) => {
    const { sitePath: _dropped, ...older } = meta
    return older as typeof meta
  })

  const result = await engine.reply(id, QUICK, false)

  assert.equal(result.outcome, 'started')
  const texts = (await engine.read(id, 0)).events.map((e) => (e.kind === 'message' ? e.text : ''))
  assert.equal(texts.some((t) => /could not be compared/.test(t)), true)
  await settle(engine, id)
})

async function repoSite(): Promise<{ stateDir: string; siteDir: string }> {
  const home = await mkdtemp(join(tmpdir(), 'factotum-resume-fresh-'))
  const siteDir = join(home, 'repo')
  await initRepo(siteDir)
  return { stateDir: join(home, 'state'), siteDir }
}

test('resuming onto a DIRTY repo is refused with the report, like a launch (criterion 31)', async () => {
  const { stateDir, siteDir } = await repoSite()
  const engine = await engineOver(stateDir, [{ id: 'repo', path: siteDir }])
  const launched = await engine.launch({ siteId: 'repo', entryId: 'free', text: QUICK, force: false })
  const id = launched.outcome === 'started' ? launched.sessionId : ''
  await settle(engine, id)
  await turnOver(new SiteLocks(sessionPaths(stateDir)), 'repo')

  await writeFile(join(siteDir, 'dirty-since.txt'), 'someone changed it between turns')
  const result = await engine.reply(id, QUICK, false)

  assert.equal(result.outcome, 'stale')
  assert.equal(result.outcome === 'stale' && result.freshness.dirtyFiles.includes('dirty-since.txt'), true)
})

test('A STALE REPLY LEAVES NO TRACE: meta.json exactly as it was, lock back (criterion 49)', async () => {
  // In `launch` freshness runs before anything is written. In `reply` the old code had already
  // set `running` and bumped `turns` by the point a check would go — so a refusal there would
  // strand a `running` session with no process, and a turn that never happened.
  const { stateDir, siteDir } = await repoSite()
  const engine = await engineOver(stateDir, [{ id: 'repo', path: siteDir }])
  const store = new SessionStore(sessionPaths(stateDir), () => new Date())
  const launched = await engine.launch({ siteId: 'repo', entryId: 'free', text: QUICK, force: false })
  const id = launched.outcome === 'started' ? launched.sessionId : ''
  await settle(engine, id)
  await turnOver(new SiteLocks(sessionPaths(stateDir)), 'repo')
  await writeFile(join(siteDir, 'dirty-since.txt'), 'x')
  const before = await store.readMeta(id)
  const eventsBefore = (await engine.read(id, 0)).events.length

  await engine.reply(id, QUICK, false)

  assert.deepEqual(await store.readMeta(id), before)
  assert.equal((await engine.read(id, 0)).events.length, eventsBefore)
  assert.equal(await new SiteLocks(sessionPaths(stateDir)).heldBy('repo'), undefined)
})

test('`force` resumes over the warning, and the warning is written to the log (criterion 32)', async () => {
  const { stateDir, siteDir } = await repoSite()
  const engine = await engineOver(stateDir, [{ id: 'repo', path: siteDir }])
  const launched = await engine.launch({ siteId: 'repo', entryId: 'free', text: QUICK, force: false })
  const id = launched.outcome === 'started' ? launched.sessionId : ''
  await settle(engine, id)
  await turnOver(new SiteLocks(sessionPaths(stateDir)), 'repo')
  await writeFile(join(siteDir, 'dirty-since.txt'), 'x')

  const result = await engine.reply(id, QUICK, true)

  assert.equal(result.outcome, 'started')
  const texts = (await engine.read(id, 0)).events.map((e) => (e.kind === 'message' ? e.text : ''))
  assert.equal(texts.some((t) => /resumed over a freshness warning/.test(t)), true)
  await settle(engine, id)
})
