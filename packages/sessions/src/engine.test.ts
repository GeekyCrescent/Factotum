import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NotificationMessage, Notifier, Timers } from '@factotum/core'
import { createEngine, PROMPT_CHARS } from './engine.ts'
import { uuidv7 } from './id.ts'
import { SiteLocks } from './locks.ts'
import { sessionPaths } from './paths.ts'
import { SessionStore } from './store.ts'
import { memoryRegistry } from './test-registry.ts'
import type { CatalogEntry, EngineSetup, EventPage, SessionEngine, SiteConfig, TitlesConfig } from './types.ts'

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

/**
 * The registry and the world around it, from the `sites` and `sharedPaths` the tests used to hand
 * the engine directly (spec 2026-09-29, D1). The home and `~/.factotum` are somewhere no test site is.
 */
function registryOf(sites: readonly SiteConfig[], sharedPaths: readonly string[] = []) {
  return {
    registry: memoryRegistry({ sites, sharedPaths }),
    home: '/nonexistent-home-for-tests',
    factotumRoot: '/nonexistent-home-for-tests/.factotum',
    installRoot: undefined,
  }
}

/** `read` as a page, failing the test when it is a refusal. */
async function readPage(engine: SessionEngine, id: string, fromSeq: number): Promise<EventPage> {
  const result = await engine.read(id, fromSeq)
  assert.equal('kind' in result, false, `read ${id} was refused: ${JSON.stringify(result)}`)
  return result as EventPage
}

/** The locks each test engine uses, so a helper can wait for a turn to be truly over. */
const engineLocks = new WeakMap<SessionEngine, SiteLocks>()

/** For the setups that are not about notices. */
const silentNotify: Notifier = { canReach: () => false, send: async () => undefined }

/**
 * The titler OFF everywhere but the tests about it (spec 2026-09-30, B0): on, every `launch` here
 * would start a second `claude` of its own.
 */
const TITLES_OFF: TitlesConfig = { enabled: false, model: 'haiku', effort: 'low' }

async function world(
  options: {
    sites?: readonly SiteConfig[]
    hookUrl?: () => string
    notify?: Notifier
    askTimeoutMs?: number
    registry?: EngineSetup['registry']
    titles?: TitlesConfig
  } = {},
): Promise<World> {
  const home = await mkdtemp(join(tmpdir(), 'factotum-engine-'))
  const stateDir = join(home, 'state')
  const siteDir = join(home, 'site')
  await mkdir(stateDir, { recursive: true })
  await mkdir(siteDir, { recursive: true })

  const warnings: string[] = []
  const notices: NotificationMessage[] = []
  const setup: EngineSetup = {
    titles: options.titles ?? TITLES_OFF,
    stateDir,
    ...registryOf(options.sites ?? [{ id: 'work', path: siteDir }]),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    catalog: CATALOG,
    log: { info: () => undefined, warn: (m: string) => void warnings.push(m), error: () => undefined },
    now: () => new Date(),
    timers,
    hookUrl: options.hookUrl ?? (() => BASE),
    // canReach FALSE by default: nobody subscribed, so the gate DENIES as it always did. Only the
    // tests about asking opt in, or every existing deny test would turn into a wait.
    notify: options.notify ?? { canReach: () => false, send: async (message) => void notices.push(message) },
  }

  const engine = await createEngine(setup, { bin: FAKE, ...(options.askTimeoutMs !== undefined ? { askTimeoutMs: options.askTimeoutMs } : {}) })
  const paths = sessionPaths(stateDir)
  engineLocks.set(engine, new SiteLocks(paths))
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

test('A PROJECT WHOSE FOLDER IS GONE FAILS ALONE: the engine comes up, launching there is refused, the other launches (criterion 23)', async () => {
  // This used to make createEngine throw and disable the whole module (ADR-0004). ADR-0011 turned
  // it round: it only ever narrowed the boundary, and it cost the owner every other project.
  const home = await mkdtemp(join(tmpdir(), 'factotum-gone-'))
  const here = join(home, 'here')
  await mkdir(here)
  const { engine, warnings } = await world({ sites: [{ id: 'gone', path: join(home, 'not-here') }, { id: 'here', path: here }] })

  const refused = await engine.launch({ siteId: 'gone', entryId: 'free', text: QUICK, force: false })
  assert.equal(refused.outcome, 'rejected')
  assert.match(refused.outcome === 'rejected' ? refused.reason : '', /project "gone" is missing/)
  assert.match(warnings.join('\n'), /project "gone" is missing/)
  assert.deepEqual(engine.view().sites.map((s) => [s.id, s.status]), [['gone', 'missing'], ['here', 'ok']])

  const started = await engine.launch({ siteId: 'here', entryId: 'free', text: QUICK, force: false })
  assert.equal(started.outcome, 'started')
  await settle(engine, started.outcome === 'started' ? started.sessionId : '')
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
  assert.equal((await readPage(engine, id, 0)).state, 'finished')
})

test('the prompt that launched a session is the first thing in its log, like a reply is', async () => {
  const { engine } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''
  await settle(engine, id)

  const first = (await readPage(engine, id, 0)).events[0]
  assert.deepEqual(first?.kind === 'message' ? [first.role, first.text] : [], ['user', QUICK])
})

test('a launch with no text writes no empty message', async () => {
  const { engine } = await world()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: '  ', force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''
  await settle(engine, id)

  const said = (await readPage(engine, id, 0)).events.filter((e) => e.kind === 'message' && e.role === 'user')
  assert.deepEqual(said, [])
})

async function settle(engine: SessionEngine, id: string): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const page = await readPage(engine, id, 0)
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
  assert.match(result.outcome === 'rejected' ? result.reason : '', /no project "nope" is registered/)
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
  // POLLED, not read once: `finalize` writes the terminal state FIRST and releases the lock LAST
  // (design D9), so `settle` can return in the few milliseconds between the two. Reading the lock
  // once right after was a flaky test, not a lock that stayed held.
  await turnOver(locks, 'work')
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
    titles: TITLES_OFF,
    stateDir: join(home, 'state'),
    ...registryOf([{ id: 'a', path: a }, { id: 'b', path: b }]),
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
    titles: TITLES_OFF,
    stateDir: join(home, 'state'),
    ...registryOf([{ id: 'a', path: a }, { id: 'b', path: b }], [vault]),
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

test('A SHARED FOLDER THAT IS NOT THERE no longer disables the module: the gate simply does not have it (criterion 23)', async () => {
  // It used to throw from createEngine, like a missing site. Now it fails alone, and it can only
  // narrow: a folder that is not there is not writable through the gate either.
  const home = await mkdtemp(join(tmpdir(), 'factotum-shared-missing-'))
  const a = join(home, 'a')
  await mkdir(a, { recursive: true })

  const setup: EngineSetup = {
    titles: TITLES_OFF,
    stateDir: join(home, 'state'),
    ...registryOf([{ id: 'a', path: a }], [join(home, 'no-such-vault')]),
    catalog: CATALOG,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date(),
    timers,
    hookUrl: () => BASE,
    notify: silentNotify,
  }
  await mkdir(setup.stateDir, { recursive: true })

  const engine = await createEngine(setup, { bin: FAKE })
  const started = await engine.launch({ siteId: 'a', entryId: 'free', text: 'linger', force: false })
  const id = started.outcome === 'started' ? started.sessionId : ''
  const denied = await engine.decide(payload(id, join(home, 'no-such-vault', 'n.md'), a))
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny')
  await engine.cancel(id)
  await engine.stop()
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
  const id = await liveSession(engine)

  const before = (await readPage(engine, id, 0)).events.length
  await engine.decide(payload(id, '/etc/passwd', '/work/site'))
  const afterDeny = await readPage(engine, id, 0)
  assert.equal(afterDeny.events.length, before + 1)
  const written = afterDeny.events.at(-1)
  assert.equal(written?.kind === 'result' ? written.ok : true, false)
  assert.match(written?.kind === 'result' ? written.summary : '', /denied: writes outside work/)

  // Criterion 2: the gate is not noise when everything is fine.
  await engine.decide(payload(id, '/etc/passwd', '/work/site', 'Read'))
  assert.equal((await readPage(engine, id, 0)).events.length, before + 1)

  await engine.cancel(id)
})

// ---------------------------------------------------------------------------
// Criterion 4, the third case: the engine is not ready
// ---------------------------------------------------------------------------

test('after stop(), launch, reply and decide all REJECT — no session exists without a gate', async () => {
  const { engine } = await world()
  await engine.stop()

  await assert.rejects(() => engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false }), /engine stopped/)
  await assert.rejects(() => engine.reply('whatever', 'hi'), /engine stopped/)
  await assert.rejects(() => engine.decide(payload('x', '/a', '/b')), /engine stopped/)
})

test('reading and listing still work after stop, because they cannot hurt anything', async () => {
  const { engine } = await world()
  await engine.stop()
  assert.deepEqual((await engine.list({ page: 0, site: undefined, archived: false })).sessions, [])
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

  const second = await engine.reply(id, QUICK)
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

  const result = await engine.reply(id, 'more')
  assert.match(result.outcome === 'rejected' ? result.reason : '', /still running/)
  await engine.cancel(id)
})

test('replying to a session nobody has heard of is refused', async () => {
  const { engine } = await world()
  const result = await engine.reply('019965aa-0000-7000-8000-00000000dead', 'hi')
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

  const result = await engine.reply(id, QUICK)
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
  while ((await readPage(engine, id, 0)).events.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  await engine.cancel(id)

  const meta = await store.readMeta(id)
  assert.equal(meta?.state, 'cancelled')
  assert.equal(meta?.reason, 'cancelled by the owner')

  // And the LOG agrees, because the log is what the screen reads.
  const page = await readPage(engine, id, 0)
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
    prompt: undefined,
    agent: undefined,
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
  for (let i = 0; i < 3; i += 1) ids.push(await finished(engine))

  const page = await engine.list({ page: 0, site: undefined, archived: false })
  assert.deepEqual(page.sessions.map((s) => s.id), [...ids].reverse())
  assert.equal(page.hasMore, false)
})

test('the list carries the FIRST prompt, cut to PROMPT_CHARS — tested on the engine, because the route forwards whatever it gets (criterion 31)', async () => {
  const { engine } = await world()
  const long = 'x'.repeat(PROMPT_CHARS + 50)
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: long, force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''
  await settle(engine, id)

  const summary = (await engine.list({ page: 0, site: undefined, archived: false })).sessions.find((s) => s.id === id)
  assert.equal(summary?.prompt, long.slice(0, PROMPT_CHARS))
  assert.equal(summary?.prompt?.length, PROMPT_CHARS)
})

test('a negative page is treated as the first one rather than throwing', async () => {
  const { engine } = await world()
  assert.equal((await engine.list({ page: -5, site: undefined, archived: false })).page, 0)
  // An id nobody has heard of, in the right shape: an empty page, not an error.
  assert.deepEqual((await readPage(engine, uuidv7(), -3)).events, [])
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
  await store.create({ id: stale, siteId: 'work', entryId: 'free', startedAt: new Date().toISOString(), sitePath: undefined, agent: undefined, prompt: undefined })
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
    titles: TITLES_OFF,
    stateDir: join(home, 'state'),
    ...registryOf([{ id: 'repo', path: siteDir }]),
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

  // And the report is the first thing in the log, so the decision is recoverable; the prompt follows.
  const [first, second] = (await readPage(engine, id, 0)).events
  assert.match(first?.kind === 'message' ? first.text : '', /launched over a freshness warning/)
  assert.equal(second?.kind === 'message' ? second.text : '', QUICK)
})

test('a refused stale launch does not keep the lock', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-fresh2-'))
  const siteDir = join(home, 'repo')
  await initRepo(siteDir)
  await writeFile(join(siteDir, 'dirty.txt'), 'x')

  const setup: EngineSetup = {
    titles: TITLES_OFF,
    stateDir: join(home, 'state'),
    ...registryOf([{ id: 'repo', path: siteDir }]),
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

  await engine.reply(id, QUICK)
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

test('a turn that ends does not wait for the notice — nothing awaiting settled pays for the phone (criterion 44)', async () => {
  // WHAT THIS DOES AND DOES NOT MEASURE, because the name used to promise more than it kept.
  // The criterion is "cancelling from the phone does not pay for a slow push", and `cancel`
  // itself CANNOT pay for one: it awaits `entry.settled`, and a cancelled session is finalized
  // with `notify: false` (criterion 51), so no send is ever started on that path. A test that
  // called `cancel` with a notifier that never resolves was written here and deleted: mutating
  // `announce` to `await` left it green, so it discriminated nothing.
  //
  // What CAN pay is anything else awaiting `settled` — a reply, a second turn, reconcile — for a
  // session that does notify. That is what this measures, and mutating `announce` to `await`
  // turns it red.
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

test('stop notifies THREE live sessions once each, all in flight at the same time (criteria 27, 45, 48)', async () => {
  // THREE, because the criterion is about N sessions paying ONE bound and not N. The earlier
  // version of this test launched a single session, so it could not tell a concurrent shutdown
  // from a serial one — with `sharedPaths` there can be several live at once, and in serial the
  // shutdown costs N × the bound.
  const started: string[] = []
  const finished: string[] = []
  const sent: string[] = []
  const slow: Notifier = {
    canReach: () => true,
    send: async (message) => {
      started.push(message.tag)
      sent.push(message.title)
      await new Promise((resolve) => setTimeout(resolve, 200))
      finished.push(message.tag)
    },
  }

  const sites = await Promise.all(
    ['one', 'two', 'three'].map(async (id) => ({ id, path: await mkdtemp(join(tmpdir(), `factotum-site-${id}-`)) })),
  )
  const { engine, store } = await world({ sites, notify: slow })

  const ids: string[] = []
  for (const site of sites) {
    const result = await engine.launch({ siteId: site.id, entryId: 'free', text: 'linger', force: false })
    ids.push(result.outcome === 'started' ? result.sessionId : '')
  }

  await engine.stop()

  // The sends are fire-and-forget, so wait for the three to be under way — then check that NONE
  // of them has finished. In serial, the third could only start after two 200ms waits had
  // completed, so `finished` would not be empty here.
  const deadline = Date.now() + 5_000
  while (started.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))

  assert.equal(started.length, 3, 'every live session was announced')
  assert.deepEqual(finished, [], 'the three notices were in flight together, not one after another')
  assert.deepEqual(sent, ['cancelled', 'cancelled', 'cancelled'])

  // After patchMeta: by the time the notice went out, the meta already said terminal — so a
  // crash after it cannot make reconcile announce the same end a second time.
  for (const id of ids) assert.equal((await store.readMeta(id))?.state, 'cancelled')
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
  await store.create({ id: crashed, siteId: 'work', entryId: 'free', startedAt: new Date().toISOString(), sitePath: undefined, agent: undefined, prompt: undefined })
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
  await store.create({ id: closed, siteId: 'work', entryId: 'free', startedAt: new Date().toISOString(), sitePath: undefined, agent: undefined, prompt: undefined })
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
  await store.create({ id: crashed, siteId: 'work', entryId: 'free', startedAt: new Date().toISOString(), sitePath: undefined, agent: undefined, prompt: undefined })
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

  await engine.reply(id, 'linger')
  await engine.decide(payload(id, '/etc/passwd', '/work/site')) // a deny: no notice
  await engine.decide(payload(id, '/etc/passwd', '/work/site', 'Read')) // an allow: no notice
  await engine.cancel(id) // cancelled from the phone: no notice
  await turnOver(locks, 'work')

  await engine.reply(id, QUICK)
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
async function engineOver(stateDir: string, sites: readonly SiteConfig[], titles: TitlesConfig = TITLES_OFF): Promise<SessionEngine> {
  await mkdir(stateDir, { recursive: true })
  return await createEngine(
    {
      titles,
      stateDir,
      ...registryOf(sites),
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

  const again = await engine.reply(id, QUICK)
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

  const result = await moved.reply(id, QUICK)

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

  const result = await engine.reply(id, QUICK)

  assert.equal(result.outcome, 'started')
  const texts = (await readPage(engine, id, 0)).events.map((e) => (e.kind === 'message' ? e.text : ''))
  assert.equal(texts.some((t) => /could not be compared/.test(t)), true)
  await settle(engine, id)
})

async function repoSite(): Promise<{ stateDir: string; siteDir: string }> {
  const home = await mkdtemp(join(tmpdir(), 'factotum-resume-fresh-'))
  const siteDir = join(home, 'repo')
  await initRepo(siteDir)
  return { stateDir: join(home, 'state'), siteDir }
}

test('resuming onto a DIRTY repo just continues: freshness is checked at launch, not on every turn', async () => {
  // After the first turn the agent's own edits leave the repo dirty, so a check per reply warned
  // on every message. The warning belongs to the start of the conversation, once.
  const { stateDir, siteDir } = await repoSite()
  const engine = await engineOver(stateDir, [{ id: 'repo', path: siteDir }])
  const launched = await engine.launch({ siteId: 'repo', entryId: 'free', text: QUICK, force: false })
  const id = launched.outcome === 'started' ? launched.sessionId : ''
  await settle(engine, id)
  await turnOver(new SiteLocks(sessionPaths(stateDir)), 'repo')
  await writeFile(join(siteDir, 'dirty-since.txt'), 'someone changed it between turns')

  const result = await engine.reply(id, QUICK)

  assert.equal(result.outcome, 'started')
  const texts = (await readPage(engine, id, 0)).events.map((e) => (e.kind === 'message' ? e.text : ''))
  assert.equal(texts.some((t) => /freshness warning/.test(t)), false)
  await settle(engine, id)
})

// ---------------------------------------------------------------------------
// ASK — the gate asks the owner, and waits (spec block E)
// ---------------------------------------------------------------------------

/** A reachable owner: records notices, so a test can read the ask's token from one. */
function reachable() {
  const notices: NotificationMessage[] = []
  const notify: Notifier = { canReach: () => true, send: async (m) => void notices.push(m) }
  return { notices, notify }
}

/** The token travels in the notice's data — the only place outside memory it ever goes. */
async function askIdFrom(notices: NotificationMessage[]): Promise<string> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const ask = notices.find((n) => typeof n.data?.['askId'] === 'string')
    if (ask !== undefined) return ask.data?.['askId'] as string
    if (Date.now() > deadline) throw new Error('no ask notice was sent')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * A running session that has GONE QUIET. The fake's `linger` writes a tool call, its result and a
 * message, then says nothing for a minute. Returning before those land let them arrive AFTER what a
 * test wrote next, so "the last event" was the fake's `File created successfully` under load — a
 * flaky test, not a missing log line.
 */
async function liveSession(engine: SessionEngine): Promise<string> {
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: 'linger', force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''
  const deadline = Date.now() + 15_000
  while (!(await readPage(engine, id, 0)).events.some((e) => e.kind === 'message' && e.role === 'assistant')) {
    if (Date.now() > deadline) throw new Error(`session ${id} never went quiet`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return id
}

test('THE ASK NOTICE carries its deadline and the drawer fields, and NEITHER the full path NOR the preview leaves the tailnet (criterion 25)', async () => {
  const { notices, notify } = reachable()
  const { engine } = await world({ notify })
  const id = await liveSession(engine)
  const secretPath = '/etc/very/secret/approved.txt'
  const secretContent = 'THE-CONTENT-NEVER-LEAVES'

  const pending = engine.decide({ ...payload(id, secretPath, '/work/site'), tool_input: { file_path: secretPath, content: secretContent } })
  const askId = await askIdFrom(notices)
  const notice = notices.find((n) => n.data?.['askId'] === askId)

  assert.ok(notice !== undefined)
  assert.equal(typeof notice.until, 'string')
  assert.ok(Date.parse(notice.until ?? '') > Date.now(), 'the deadline is in the future')
  assert.deepEqual(notice.data, { askId, sessionId: id, siteId: 'work', toolName: 'Write', file: 'approved.txt' })
  const wire = JSON.stringify(notice)
  assert.equal(wire.includes(secretPath), false, 'the full path must not be in the notice')
  assert.equal(wire.includes('/etc/very/secret'), false, 'no part of the directory either')
  assert.equal(wire.includes(secretContent), false, 'the preview must not be in the notice')

  await engine.answer(askId, 'deny')
  await pending
  await engine.cancel(id)
})

test('INSPECT: a pending ask reads with its full path and the preview cut from the tool input; then settled; unknown otherwise (criterion 23)', async () => {
  const { notices, notify } = reachable()
  const { engine } = await world({ notify })
  const id = await liveSession(engine)

  const pending = engine.decide({ ...payload(id, '/etc/hosts', '/work/site'), tool_input: { file_path: '/etc/hosts', content: 'one line' } })
  const askId = await askIdFrom(notices)

  const read = await engine.inspect(askId)
  assert.equal(read.kind, 'pending')
  if (read.kind === 'pending') {
    assert.equal(read.sessionId, id)
    assert.equal(read.toolName, 'Write')
    assert.equal(read.target, '/etc/hosts')
    assert.deepEqual(read.preview, { head: 'one line', tail: '', total: 8, edits: null })
    assert.equal(read.deadlineAt, notices.find((n) => n.data?.['askId'] === askId)?.until)
  }

  await engine.answer(askId, 'deny')
  await pending
  assert.deepEqual(await engine.inspect(askId), { kind: 'settled' })
  assert.deepEqual(await engine.inspect('no-such-token'), { kind: 'unknown' })
  await engine.cancel(id)
})

test('ALLOWED FROM THE PHONE: the held reply becomes allow, and the log says who granted it (criteria 11, 15)', async () => {
  const { notices, notify } = reachable()
  const { engine } = await world({ notify })
  const id = await liveSession(engine)

  const pending = engine.decide(payload(id, '/etc/hosts', '/work/site'))
  const askId = await askIdFrom(notices)
  assert.deepEqual(await engine.answer(askId, 'allow'), { kind: 'answered' })

  const decision = await pending
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow')
  const last = (await readPage(engine, id, 0)).events.at(-1)
  assert.equal(last?.kind === 'result' && last.ok, true)
  assert.match(last?.kind === 'result' ? last.summary : '', /approved by the owner/)
  await engine.cancel(id)
})

test('DENIED FROM THE PHONE: deny, with the boundary reason, and the log says so (criterion 16)', async () => {
  const { notices, notify } = reachable()
  const { engine } = await world({ notify })
  const id = await liveSession(engine)

  const pending = engine.decide(payload(id, '/etc/hosts', '/work/site'))
  await engine.answer(await askIdFrom(notices), 'deny')

  const decision = await pending
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /writes outside work/)
  const last = (await readPage(engine, id, 0)).events.at(-1)
  assert.match(last?.kind === 'result' ? last.summary : '', /denied by the owner/)
  await engine.cancel(id)
})

test('NOBODY ANSWERS: deny, the session stays alive, and the log says nobody answered (criterion 17)', async () => {
  const { notify } = reachable()
  const { engine } = await world({ notify, askTimeoutMs: 50 })
  const id = await liveSession(engine)

  const decision = await engine.decide(payload(id, '/etc/hosts', '/work/site'))

  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
  const page = await readPage(engine, id, 0)
  assert.equal(page.state, 'running', 'a deny does not end the session — measured against the CLI too')
  const last = page.events.at(-1)
  assert.match(last?.kind === 'result' ? last.summary : '', /nobody answered/)
  await engine.cancel(id)
})

test('NOBODY SUBSCRIBED: deny AT ONCE, no notice, no wait (criterion 13)', async () => {
  const { notices } = reachable()
  const unreachable: Notifier = { canReach: () => false, send: async (m) => void notices.push(m) }
  const { engine } = await world({ notify: unreachable, askTimeoutMs: 60_000 })
  const id = await liveSession(engine)

  const started = Date.now()
  const decision = await engine.decide(payload(id, '/etc/hosts', '/work/site'))

  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
  assert.ok(Date.now() - started < 1_000, 'did not wait for a timeout')
  assert.equal(notices.length, 0)
  await engine.cancel(id)
})

test('the deny that is NOT a question stays a deny and asks nobody — unknown session (criterion 14)', async () => {
  const { notices, notify } = reachable()
  const { engine } = await world({ notify })

  const decision = await engine.decide(payload('01990000-0000-7000-8000-00000000dead', '/etc/hosts', '/work/site'))

  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(notices.length, 0)
})

test('TWO ASKS, TWO SESSIONS: answering one leaves the other waiting, and each notice names its own (criterion 19)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-two-asks-'))
  const a = join(home, 'a')
  const b = join(home, 'b')
  await mkdir(a, { recursive: true })
  await mkdir(b, { recursive: true })
  const { notices, notify } = reachable()
  const { engine } = await world({ sites: [{ id: 'a', path: a }, { id: 'b', path: b }], notify })
  const one = await engine.launch({ siteId: 'a', entryId: 'free', text: 'linger', force: false })
  const two = await engine.launch({ siteId: 'b', entryId: 'free', text: 'linger', force: false })
  const idA = one.outcome === 'started' ? one.sessionId : ''
  const idB = two.outcome === 'started' ? two.sessionId : ''

  const pendingA = engine.decide(payload(idA, '/etc/hosts', a))
  const pendingB = engine.decide(payload(idB, '/etc/passwd', b))
  const deadline = Date.now() + 5_000
  while (notices.filter((n) => n.data?.['askId'] !== undefined).length < 2) {
    if (Date.now() > deadline) throw new Error('two ask notices never arrived')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const forA = notices.find((n) => n.tag === `ask:${idA}`)
  const forB = notices.find((n) => n.tag === `ask:${idB}`)
  assert.notEqual(forA, undefined)
  assert.notEqual(forB, undefined)

  await engine.answer(forA?.data?.['askId'] as string, 'allow')
  assert.equal((await pendingA).hookSpecificOutput.permissionDecision, 'allow')

  let bSettled = false
  void pendingB.then(() => (bSettled = true))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(bSettled, false, 'answering A must not answer B')

  await engine.answer(forB?.data?.['askId'] as string, 'deny')
  assert.equal((await pendingB).hookSpecificOutput.permissionDecision, 'deny')
  await engine.cancel(idA)
  await engine.cancel(idB)
})

test('A SHUTDOWN WITH AN ASK HANGING resolves it as a deny — no promise outlives the engine (criterion 22)', async () => {
  const { notices, notify } = reachable()
  const { engine } = await world({ notify })
  const id = await liveSession(engine)

  const pending = engine.decide(payload(id, '/etc/hosts', '/work/site'))
  await askIdFrom(notices)
  await engine.stop()

  const decision = await pending
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
})

test('THE TOKEN NEVER TOUCHES DISK: not in the log, not in meta.json, not in the warnings (criterion 46)', async () => {
  // The gated agent can read any file on this machine. An id written anywhere it can read is an
  // id handed to it.
  const { notices, notify } = reachable()
  const { engine, stateDir, warnings } = await world({ notify })
  const id = await liveSession(engine)

  const pending = engine.decide(payload(id, '/etc/hosts', '/work/site'))
  const askId = await askIdFrom(notices)
  await engine.answer(askId, 'allow')
  await pending
  await engine.cancel(id)

  const { readdir } = await import('node:fs/promises')
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...(await walk(path)))
      else out.push(await readFile(path, 'utf8'))
    }
    return out
  }
  for (const content of await walk(stateDir)) assert.equal(content.includes(askId), false, 'the token is on disk')
  assert.equal(warnings.join('\n').includes(askId), false)
})

test('an invented token answers nothing, and the real ask keeps waiting (criterion 46)', async () => {
  const { notices, notify } = reachable()
  const { engine } = await world({ notify })
  const id = await liveSession(engine)

  const pending = engine.decide(payload(id, '/etc/hosts', '/work/site'))
  const askId = await askIdFrom(notices)
  assert.deepEqual(await engine.answer('A'.repeat(43), 'allow'), { kind: 'unknown' })

  let settled = false
  void pending.then(() => (settled = true))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(settled, false)

  await engine.answer(askId, 'deny')
  await pending
  await engine.cancel(id)
})

test('THE ASK NOTICE carries the site, the tool and the FILE NAME — never the full path (criterion 29)', async () => {
  const { notices, notify } = reachable()
  const { engine } = await world({ notify })
  const id = await liveSession(engine)

  const pending = engine.decide(payload(id, '/Users/someone/secret-project/plans/q3.md', '/work/site'))
  const askId = await askIdFrom(notices)
  const notice = notices.find((n) => n.data?.['askId'] === askId)

  assert.match(notice?.body ?? '', /work/)
  assert.match(notice?.body ?? '', /Write/)
  assert.match(notice?.body ?? '', /q3\.md/)
  assert.doesNotMatch(JSON.stringify(notice?.body), /secret-project|\/Users\//)
  // The tag names the SESSION, not the token: a tag reaches OS surfaces we do not control.
  assert.equal(notice?.tag, `ask:${id}`)
  assert.equal(notice?.tag?.includes(askId), false)
  // And the path lands in that session WITH the token, for the no-buttons route (criterion 55).
  assert.equal(notice?.path, `/m/sessions/${id}?ask=${askId}`)

  await engine.answer(askId, 'deny')
  await pending
  await engine.cancel(id)
})

// ---------------------------------------------------------------------------
// Projects that fail alone (spec 2026-09-29, block B: criteria 6, 23, 25)
// ---------------------------------------------------------------------------

test('A LIVE SESSION KEEPS THE BOUNDARY IT STARTED WITH when its folder goes missing; a new launch there is refused (criterion 23)', async () => {
  const { engine, siteDir } = await world()
  const started = await engine.launch({ siteId: 'work', entryId: 'free', text: 'linger', force: false })
  const id = started.outcome === 'started' ? started.sessionId : ''
  assert.notEqual(id, '')

  // The folder goes away under the running agent (moved, here, so it can come back).
  await rename(siteDir, `${siteDir}-moved`)
  const refused = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  assert.equal(refused.outcome, 'rejected')
  assert.equal(engine.view().sites[0]?.status, 'missing')

  // The gate still answers from the site the session started with: no new denial because of it.
  const decision = await engine.decide(payload(id, join(siteDir, 'still-mine.txt'), siteDir))
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow')

  await rename(`${siteDir}-moved`, siteDir)
  await engine.cancel(id)
})

test('A CONVERSATION OF A MISSING PROJECT IS NOT READ: site-missing, and it reads again when the folder is back (criteria 24, 25)', async () => {
  const { engine, siteDir } = await world()
  const started = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  const id = started.outcome === 'started' ? started.sessionId : ''
  await settle(engine, id)

  await rename(siteDir, `${siteDir}-moved`)
  assert.deepEqual(await engine.read(id, 0), { kind: 'site-missing', siteId: 'work' })
  const reply = await engine.reply(id, 'more')
  assert.equal(reply.outcome, 'rejected')

  await rename(`${siteDir}-moved`, siteDir)
  assert.equal((await readPage(engine, id, 0)).state, 'finished')
})

test('an id that is not a session id is refused before it becomes a path (criterion 32)', async () => {
  const { engine } = await world()
  assert.deepEqual(await engine.read('../../etc', 0), { kind: 'invalid' })
  const reply = await engine.reply('../x', 'hi')
  assert.equal(reply.outcome, 'rejected')
})

test('A BROKEN REGISTRY starts the engine with NO project, and nothing launches (criterion 6)', async () => {
  const { engine, warnings } = await world({ registry: memoryRegistry({}, { broken: 'projects.json is not valid JSON' }) })
  assert.deepEqual(engine.view().sites, [])
  assert.match(warnings.join('\n'), /registry is broken.*not valid JSON/)
  const refused = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })
  assert.equal(refused.outcome, 'rejected')
})

test('the view carries each project’s name, colour and status (criterion 26)', async () => {
  const registry = memoryRegistry({ sites: [] })
  const home = await mkdtemp(join(tmpdir(), 'factotum-named-'))
  await registry.update(async () => ({ kind: 'add-project', id: 'web', path: home, name: 'Web app', color: 4 }))
  const { engine } = await world({ registry })
  assert.deepEqual(engine.view().sites, [{ id: 'web', path: home, isRepo: false, name: 'Web app', color: 4, status: 'ok' }])
})

// ---------------------------------------------------------------------------
// The history (spec 2026-09-29, block E: criteria 20, 24, 29-37)
// ---------------------------------------------------------------------------

/**
 * A finished session in `siteId`, launched through the engine — and OVER: the log says `finished`
 * a moment before the engine lets go of the session and its lock, so this waits for the lock.
 */
async function finished(engine: SessionEngine, siteId = 'work', text = QUICK): Promise<string> {
  const result = await engine.launch({ siteId, entryId: 'free', text, force: false })
  const id = result.outcome === 'started' ? result.sessionId : ''
  assert.notEqual(id, '', JSON.stringify(result))
  await settle(engine, id)
  const locks = engineLocks.get(engine)
  const deadline = Date.now() + 15_000
  while (locks !== undefined && (await locks.heldBy(siteId)) !== undefined) {
    if (Date.now() > deadline) throw new Error(`the lock on ${siteId} never came back`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return id
}

test('THE INDEX SEES WHAT RECONCILE WROTE: a session a crash left running lists as failed (criterion 37)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-idx-'))
  const stateDir = join(home, 'state')
  const siteDir = join(home, 'site')
  await mkdir(siteDir, { recursive: true })
  const store = new SessionStore(sessionPaths(stateDir), () => new Date())
  await store.ensureRoots()
  const stale = uuidv7()
  await store.create({ id: stale, siteId: 'work', entryId: 'free', startedAt: new Date().toISOString(), sitePath: siteDir, agent: undefined, prompt: 'left running' })
  await new SiteLocks(sessionPaths(stateDir), 999_999).acquire('work', stale, new Date().toISOString())

  const engine = await engineOver(stateDir, [{ id: 'work', path: siteDir }])
  await engine.reconcile()
  const page = await engine.list({ page: 0, site: 'work', archived: false })
  assert.deepEqual(page.sessions.map((s) => [s.id, s.state]), [[stale, 'failed']])
})

test('RENAME: trimmed, cut to 80, and it survives the next turn’s patchMeta; EMPTY CLEARS IT (criteria 29, 30; 2026-09-30 crit. 23)', async () => {
  const { engine } = await world()
  const id = await finished(engine)
  const renamed = await engine.rename(id, `  ${'t'.repeat(100)}  `)
  assert.equal(renamed.outcome, 'ok')
  assert.equal(renamed.outcome === 'ok' ? renamed.summary.title : '', 't'.repeat(80))
  assert.equal((await engine.rename(uuidv7(), 'x')).outcome, 'unknown')
  assert.equal((await engine.rename('../x', 'x')).outcome, 'invalid')

  // Another turn: finalize patches the meta again and the title stays.
  await engine.reply(id, QUICK)
  await settle(engine, id)
  const summary = await engine.summary(id)
  assert.equal(summary.kind === 'ok' ? summary.summary.title : '', 't'.repeat(80))

  // Empty, or only spaces, CLEARS the owner's title: what shows is the titler's or the first line.
  // It used to be refused (spec 2026-09-29, criterion 30); spec 2026-09-30 turns it round on purpose.
  const cleared = await engine.rename(id, '   ')
  assert.equal(cleared.outcome, 'ok')
  assert.equal(cleared.outcome === 'ok' ? cleared.summary.title : 'still there', undefined)
})

test('AUTO TITLE: the real engine hands it out in list, summary, projects and search, and a rename leaves it (2026-09-30 crit. 22, 24, 25)', async () => {
  // THE ENGINE, NOT THE SERVER: the server passes the engine's objects through untouched, so the
  // one place `autoTitle` can be dropped is `summaryOf` — and only this test would notice.
  const { engine, stateDir, siteDir, store } = await world()
  const id = await finished(engine)
  await engine.stop()
  await store.patchMeta(id, (meta) => ({ ...meta, autoTitle: 'Plan de maratón' }))

  const again = await engineOver(stateDir, [{ id: 'work', path: siteDir }])
  await again.reconcile()
  const listed = await again.list({ page: 0, site: undefined, archived: false })
  assert.equal(listed.sessions.find((s) => s.id === id)?.autoTitle, 'Plan de maratón')
  const one = await again.summary(id)
  assert.equal(one.kind === 'ok' ? one.summary.autoTitle : '', 'Plan de maratón')
  const projects = await again.projects()
  assert.equal(projects.projects[0]?.sessions.find((s) => s.id === id)?.autoTitle, 'Plan de maratón')
  // The prompt is `quick`: only the titler's title says "maratón".
  const hits = await again.search('maratón')
  assert.deepEqual(
    hits.map((hit) => hit.summary.id),
    [id],
  )
  assert.equal(hits[0]?.summary.autoTitle, 'Plan de maratón')

  // The owner's title sits NEXT to it; clearing the owner's leaves the titler's where it was.
  const renamed = await again.rename(id, 'Mine')
  assert.deepEqual(renamed.outcome === 'ok' ? [renamed.summary.title, renamed.summary.autoTitle] : [], ['Mine', 'Plan de maratón'])
  const cleared = await again.rename(id, '')
  assert.deepEqual(cleared.outcome === 'ok' ? [cleared.summary.title, cleared.summary.autoTitle] : [], [undefined, 'Plan de maratón'])
  await again.stop()
})

test('ARCHIVE: out of the drawer’s lists, still readable, reversible; a running one is refused (criterion 31)', async () => {
  const { engine } = await world()
  const id = await finished(engine)
  const archived = await engine.archive(id, true)
  assert.equal(archived.outcome === 'ok' && archived.summary.archived, true)
  assert.deepEqual((await engine.list({ page: 0, site: undefined, archived: false })).sessions, [])
  assert.deepEqual((await engine.list({ page: 0, site: 'work', archived: true })).sessions.map((s) => s.id), [id])
  const projects = await engine.projects()
  assert.equal(projects.projects[0]?.total, 0)
  assert.equal(projects.projects[0]?.archived, 1)
  assert.equal((await engine.archive(id, false)).outcome, 'ok')
  assert.equal((await engine.list({ page: 0, site: undefined, archived: false })).sessions.length, 1)

  const live = await engine.launch({ siteId: 'work', entryId: 'free', text: 'linger', force: false })
  const liveId = live.outcome === 'started' ? live.sessionId : ''
  assert.deepEqual(await engine.archive(liveId, true), { outcome: 'running' })
  await engine.cancel(liveId)
})

test('DELETE SEVERAL: a result per id, in order — removed, running, unknown, invalid (criteria 32, 34)', async () => {
  const { engine, stateDir } = await world()
  const done = await finished(engine)
  const live = await engine.launch({ siteId: 'work', entryId: 'free', text: 'linger', force: false })
  const liveId = live.outcome === 'started' ? live.sessionId : ''
  const nobody = uuidv7()
  const results = await engine.remove([done, liveId, nobody, '../../etc'])
  assert.deepEqual(results, [
    { id: done, outcome: 'removed' },
    { id: liveId, outcome: 'running' },
    { id: nobody, outcome: 'unknown' },
    { id: '../../etc', outcome: 'invalid' },
  ])
  await assert.rejects(() => readFile(join(stateDir, 'sessions', done, 'meta.json')), /ENOENT/)
  assert.equal((await engine.summary(done)).kind, 'unknown')
  await engine.cancel(liveId)
})

test('A REPLY BEHIND A DELETE is rejected “deleted”, gives the lock back, and makes nothing again (criterion 33)', async () => {
  // A repository, so the reply spends a git check between taking the lock and writing anything:
  // that is the window the delete lands in.
  const home = await mkdtemp(join(tmpdir(), 'factotum-race-'))
  const repo = join(home, 'repo')
  await initRepo(repo)
  const { engine, stateDir, locks } = await world({ sites: [{ id: 'repo', path: repo }] })
  const launched = await engine.launch({ siteId: 'repo', entryId: 'free', text: QUICK, force: true })
  const id = launched.outcome === 'started' ? launched.sessionId : ''
  await settle(engine, id)

  const [reply, removed] = await Promise.all([engine.reply(id, 'one more'), engine.remove([id])])
  if (removed[0]?.outcome === 'removed') {
    assert.deepEqual(reply, { outcome: 'rejected', reason: 'that conversation was deleted' })
    assert.equal(await locks.heldBy('repo'), undefined, 'the lock came back')
    await assert.rejects(() => readFile(join(stateDir, 'sessions', id, 'settings.json')), /ENOENT/)
  } else {
    // The reply won the turn: then it runs, and the delete said so. Never both, never neither.
    assert.equal(removed[0]?.outcome, 'running')
    assert.equal(reply.outcome, 'started')
    await settle(engine, id)
  }
})

test('GET ONE: its summary, its title and its project’s colour; unknown, missing and invalid are said (criterion 36)', async () => {
  const registry = memoryRegistry()
  const home = await mkdtemp(join(tmpdir(), 'factotum-one-'))
  await registry.update(async () => ({ kind: 'add-project', id: 'work', path: home, name: 'Work', color: 5 }))
  const { engine } = await world({ registry })
  const id = await finished(engine)
  const one = await engine.summary(id)
  assert.equal(one.kind, 'ok')
  if (one.kind !== 'ok') return
  assert.equal(one.summary.id, id)
  assert.deepEqual(one.project, { id: 'work', name: 'Work', color: 5 })
  assert.deepEqual(await engine.summary(uuidv7()), { kind: 'unknown' })
  assert.deepEqual(await engine.summary('projects'), { kind: 'invalid' })

  await rename(home, `${home}-moved`)
  assert.deepEqual(await engine.summary(id), { kind: 'site-missing', siteId: 'work' })
  await rename(`${home}-moved`, home)
})

test('PROJECTS: the newest 8 and every running one, a total, and SHOW MORE through the site list (criterion 35)', async () => {
  const { engine } = await world()
  const ids: string[] = []
  for (let i = 0; i < 10; i++) ids.push(await finished(engine))
  const page = await engine.projects()
  const work = page.projects[0]
  assert.equal(work?.sessions.length, 8)
  assert.deepEqual(work?.sessions.map((s) => s.id), [...ids].reverse().slice(0, 8))
  assert.equal(work?.total, 10)
  assert.equal(work?.status, 'ok')
  assert.equal(page.registryError, undefined)
  assert.equal(page.file, '/memory/projects.json')
  assert.equal(page.canRequest, false)

  const more = await engine.list({ page: 0, site: 'work', archived: false })
  assert.equal(more.sessions.length, 10)
  assert.equal(more.hasMore, false)
})

test('REMOVED PROJECTS: conversations whose project is not registered are counted apart, and in no list (criterion 28)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-removed-'))
  const stateDir = join(home, 'state')
  const a = join(home, 'a')
  await mkdir(a, { recursive: true })
  const store = new SessionStore(sessionPaths(stateDir), () => new Date())
  await store.ensureRoots()
  for (let i = 0; i < 3; i++) {
    const id = uuidv7()
    await store.create({ id, siteId: 'demo', entryId: 'free', startedAt: new Date().toISOString(), sitePath: undefined, agent: undefined, prompt: 'old' })
    await store.patchMeta(id, (m) => ({ ...m, state: 'finished' }))
  }
  const engine = await engineOver(stateDir, [{ id: 'a', path: a }])
  await engine.reconcile()
  const page = await engine.projects()
  assert.deepEqual(page.removed, [{ siteId: 'demo', count: 3 }])
  assert.deepEqual((await engine.list({ page: 0, site: undefined, archived: false })).sessions, [])
})

test('A MISSING PROJECT shows no conversations and its site list is empty; it COMES BACK on the next look (criteria 24, 25)', async () => {
  const { engine, siteDir } = await world()
  await finished(engine)
  await rename(siteDir, `${siteDir}-moved`)
  const gone = await engine.projects()
  assert.equal(gone.projects[0]?.status, 'missing')
  assert.match(gone.projects[0]?.reason ?? '', /does not exist/)
  assert.deepEqual(gone.projects[0]?.sessions, [])
  assert.equal(gone.projects[0]?.total, 1)
  assert.deepEqual((await engine.list({ page: 0, site: 'work', archived: false })).sessions, [])

  await rename(`${siteDir}-moved`, siteDir)
  const back = await engine.projects()
  assert.equal(back.projects[0]?.status, 'ok')
  assert.equal(back.projects[0]?.sessions.length, 1)
})

test('A SHARED FOLDER THAT REAPPEARS joins the gate at the next look — only with nothing running (criterion 20)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-back-'))
  const a = join(home, 'a')
  const vault = join(home, 'vault')
  await mkdir(a, { recursive: true })
  const setup: EngineSetup = {
    titles: TITLES_OFF,
    stateDir: join(home, 'state'),
    ...registryOf([{ id: 'a', path: a }], [vault]),
    catalog: CATALOG,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date(),
    timers,
    hookUrl: () => BASE,
    notify: silentNotify,
  }
  await mkdir(setup.stateDir, { recursive: true })
  const engine = await createEngine(setup, { bin: FAKE })
  const target = join(vault, 'n.md')

  // Missing at start: not in the gate.
  let live = await engine.launch({ siteId: 'a', entryId: 'free', text: 'linger', force: false })
  let id = live.outcome === 'started' ? live.sessionId : ''
  assert.equal((await engine.decide(payload(id, target, a))).hookSpecificOutput.permissionDecision, 'deny')

  // It comes back WHILE a session runs: the projects list sees it, the gate does not change.
  await mkdir(vault)
  assert.equal((await engine.projects()).shared[0]?.status, 'ok')
  assert.equal((await engine.decide(payload(id, target, a))).hookSpecificOutput.permissionDecision, 'deny')
  await engine.cancel(id)

  // With nothing running, the next look puts it in the gate.
  await engine.projects()
  live = await engine.launch({ siteId: 'a', entryId: 'free', text: 'linger', force: false })
  id = live.outcome === 'started' ? live.sessionId : ''
  assert.equal((await engine.decide(payload(id, target, a))).hookSpecificOutput.permissionDecision, 'allow')
  await engine.cancel(id)
})

// ---------------------------------------------------------------------------
// The titler, wired in (spec 2026-09-30, D7). ON only in these tests: everywhere else TITLES_OFF.
// ---------------------------------------------------------------------------

const TITLES_ON: TitlesConfig = { enabled: true, model: 'haiku', effort: 'low' }

/** What the titler was started with, from the fake's own log in the titler's directory (D6). */
async function titlerCalls(stateDir: string): Promise<readonly { owner: string; pid: number }[]> {
  try {
    const text = await readFile(join(sessionPaths(stateDir).titler, 'titler-calls.log'), 'utf8')
    return text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { owner: string; pid: number })
  } catch {
    return []
  }
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const gone = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

test('TITLER: launch does not wait for it; the title lands later, in the titler’s own directory, and survives finalize and reconcile (2026-09-30 crit. 3, 19, 21)', async () => {
  const { engine, stateDir, siteDir, store } = await world({ titles: TITLES_ON })
  // The directory exists before anything is launched, and it is not the project's (crit. 19).
  assert.ok((await stat(sessionPaths(stateDir).titler)).isDirectory())

  const launched = await engine.launch({ siteId: 'work', entryId: 'free', text: 'title:slow:300', force: false })
  assert.equal(launched.outcome, 'started')
  const id = launched.outcome === 'started' ? launched.sessionId : ''
  // Returned BEFORE the titler answered (crit. 3).
  assert.equal((await store.readMeta(id))?.autoTitle, undefined)

  await until(async () => (await store.readMeta(id))?.autoTitle === 'Plan de maratón', 'the title written')
  assert.deepEqual((await titlerCalls(stateDir)).map((call) => call.owner), ['title:slow:300'])

  // Another turn: finalize patches the meta again, and the title stays (crit. 21).
  await settle(engine, id)
  await turnOver(engineLocks.get(engine)!, 'work')
  await engine.reply(id, QUICK)
  await settle(engine, id)
  assert.equal((await store.readMeta(id))?.autoTitle, 'Plan de maratón')
  await turnOver(engineLocks.get(engine)!, 'work')
  await engine.stop()

  // And a boot's reconcile reads it back (crit. 21).
  const again = await engineOver(stateDir, [{ id: 'work', path: siteDir }])
  await again.reconcile()
  const one = await again.summary(id)
  assert.equal(one.kind === 'ok' ? one.summary.autoTitle : '', 'Plan de maratón')
  await again.stop()
})

test('TITLER: the owner’s title and one already written are never overwritten (2026-09-30 crit. 15, 22)', async () => {
  const { engine, stateDir, store } = await world({ titles: TITLES_ON })

  // Renamed while the titler thinks: both end up side by side (crit. 22).
  const first = await engine.launch({ siteId: 'work', entryId: 'free', text: 'title:slow:400', force: false })
  const renamedId = first.outcome === 'started' ? first.sessionId : ''
  await engine.rename(renamedId, 'Mine')
  await until(async () => (await store.readMeta(renamedId))?.autoTitle !== undefined, 'the title written')
  const renamed = await store.readMeta(renamedId)
  assert.deepEqual([renamed?.title, renamed?.autoTitle], ['Mine', 'Plan de maratón'])
  await settle(engine, renamedId)
  await turnOver(engineLocks.get(engine)!, 'work')

  // A title already there when the titler answers stays (crit. 15).
  const second = await engine.launch({ siteId: 'work', entryId: 'free', text: 'title:slow:400', force: false })
  const keptId = second.outcome === 'started' ? second.sessionId : ''
  await store.patchMeta(keptId, (meta) => ({ ...meta, autoTitle: 'Earlier' }))
  await until(async () => (await titlerCalls(stateDir)).length === 2, 'the second titler started')
  const pid = (await titlerCalls(stateDir))[1]!.pid
  await until(async () => gone(pid), 'the second titler done')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal((await store.readMeta(keptId))?.autoTitle, 'Earlier')
  await settle(engine, keptId)
  await turnOver(engineLocks.get(engine)!, 'work')
  await engine.stop()
})

test('TITLER: a boot’s reconcile and a reply never start it; only a launch does (2026-09-30 crit. 13, 14)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factotum-titler-engine-'))
  const stateDir = join(home, 'state')
  const siteDir = join(home, 'site')
  await mkdir(siteDir, { recursive: true })
  const sites = [{ id: 'work', path: siteDir }]

  // Sessions from before, launched with the titler OFF: nothing of theirs is in the log.
  const off = await engineOver(stateDir, sites)
  const old = await off.launch({ siteId: 'work', entryId: 'free', text: 'title:ok', force: false })
  const oldId = old.outcome === 'started' ? old.sessionId : ''
  await settle(off, oldId)
  await turnOver(new SiteLocks(sessionPaths(stateDir)), 'work')
  await off.stop()
  assert.deepEqual(await titlerCalls(stateDir), [])

  // The titler ON, over the same state. THE WITNESS FIRST: a launch here does write a line, so an
  // empty log below means "not started", not "could not have been seen".
  const on = await engineOver(stateDir, sites, TITLES_ON)
  await on.reconcile()
  assert.deepEqual(await titlerCalls(stateDir), [], 'reconcile started the titler (crit. 13)')
  const witness = await on.launch({ siteId: 'work', entryId: 'free', text: 'title:none', force: false })
  const witnessId = witness.outcome === 'started' ? witness.sessionId : ''
  await until(async () => (await titlerCalls(stateDir)).length === 1, 'the witness titled')
  await settle(on, witnessId)
  await turnOver(new SiteLocks(sessionPaths(stateDir)), 'work')

  // A reply to the old session, with a text the fake WOULD title (crit. 14).
  await on.reply(oldId, 'title:ok')
  await settle(on, oldId)
  await turnOver(new SiteLocks(sessionPaths(stateDir)), 'work')
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal((await titlerCalls(stateDir)).length, 1, 'reply started the titler (crit. 14)')
  const store = new SessionStore(sessionPaths(stateDir), () => new Date())
  assert.equal((await store.readMeta(oldId))?.autoTitle, undefined)
  await on.stop()
})

// ---------------------------------------------------------------------------
// The list the CLI announces (spec 2026-10-03-skills-a-mano, D2: criteria 1, 2, 5)
// ---------------------------------------------------------------------------

test('the list is unknown until a session has run, and a session that announces one leaves it known and on disk (criteria 1, 2)', async () => {
  const { engine, stateDir } = await world()
  assert.equal(engine.announced(), undefined)

  const plain = await finished(engine, 'work', QUICK)
  assert.equal(engine.announced(), undefined, 'the made-up init of a plain turn announces no list')
  const id = await finished(engine, 'work', 'announce')

  const announced = engine.announced()
  assert.ok(announced)
  assert.ok(announced.skills.includes('superpowers:brainstorming'))
  assert.equal(announced.version, '2.1.288')
  await until(async () => (await stat(sessionPaths(stateDir).announcedFile).catch(() => undefined)) !== undefined, 'announced.json written')
  const saved = JSON.parse(await readFile(sessionPaths(stateDir).announcedFile, 'utf8')) as { skills: string[]; since: string }
  assert.deepEqual(saved.skills, announced.skills)
  assert.equal(saved.since, announced.since)

  // The init is not an event: the log holds the same kinds as that of a session without a list (criterion 5).
  const kindsOf = async (sessionId: string): Promise<string[]> => (await readPage(engine, sessionId, 0)).events.map((event) => event.kind)
  assert.deepEqual(await kindsOf(id), await kindsOf(plain))
})

test('a restarted engine still has the list, and a second session with the same list keeps since (criteria 1, 2)', async () => {
  const { engine, stateDir, siteDir } = await world()
  await finished(engine, 'work', 'announce')
  const first = engine.announced()
  await until(async () => (await stat(sessionPaths(stateDir).announcedFile).catch(() => undefined)) !== undefined, 'announced.json written')
  await engine.stop()

  const again = await engineOver(stateDir, [{ id: 'work', path: siteDir }])
  assert.deepEqual(again.announced(), first)

  await new Promise((resolve) => setTimeout(resolve, 20))
  engineLocks.set(again, new SiteLocks(sessionPaths(stateDir)))
  await finished(again, 'work', 'announce')
  assert.equal(again.announced()?.since, first?.since)
  await again.stop()
})

test('a reply announces too, because it spawns the CLI again', async () => {
  const { engine } = await world()
  const id = await finished(engine, 'work', QUICK)
  assert.equal(engine.announced(), undefined)

  await engine.reply(id, 'announce')
  await until(async () => engine.announced() !== undefined, 'the reply announced')
  await settle(engine, id)
})

// ---------------------------------------------------------------------------
// Launching as an agent (spec 2026-10-03-skills-a-mano, D3: criteria 6-10)
// ---------------------------------------------------------------------------

/** The argv of every turn of a session, as the fake CLI recorded them. */
async function argvOf(stateDir: string, id: string): Promise<string[][]> {
  const text = await readFile(join(sessionPaths(stateDir).sessionDir(id), 'argv.log'), 'utf8')
  return text.trim().split('\n').map((line) => JSON.parse(line) as string[])
}

/** A world whose CLI has already announced its list (`code-reviewer` is in it). */
async function worldWithList(): Promise<World> {
  const w = await world()
  await finished(w.engine, 'work', 'announce')
  assert.ok(w.engine.announced()?.agents.includes('code-reviewer'))
  return w
}

/** Waits until the lock of `work` is back, i.e. the turn is truly over and `patchMeta` has run. */
async function endOfTurn(engine: SessionEngine, id: string): Promise<void> {
  await settle(engine, id)
  const locks = engineLocks.get(engine)
  const deadline = Date.now() + 15_000
  while (locks !== undefined && (await locks.heldBy('work')) !== undefined) {
    if (Date.now() > deadline) throw new Error(`the lock on work never came back for ${id}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('a launch with an agent passes --agent and saves it in meta.json (criterion 6)', async () => {
  const { engine, stateDir, store } = await worldWithList()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false, agent: 'code-reviewer' })
  assert.equal(result.outcome, 'started', JSON.stringify(result))
  const id = result.outcome === 'started' ? result.sessionId : ''
  await endOfTurn(engine, id)

  const [first] = await argvOf(stateDir, id)
  assert.ok(first)
  const at = first.indexOf('--agent')
  assert.notEqual(at, -1, 'the first turn carries --agent')
  assert.equal(first[at + 1], 'code-reviewer')
  assert.equal((await store.readMeta(id))?.agent, 'code-reviewer')
  await engine.stop()
})

test('a reply does not pass --agent again, and meta.agent is still there after the turn ends (criterion 7)', async () => {
  const { engine, stateDir, store } = await worldWithList()
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false, agent: 'code-reviewer' })
  const id = result.outcome === 'started' ? result.sessionId : ''
  assert.notEqual(id, '', JSON.stringify(result))
  await endOfTurn(engine, id)

  const reply = await engine.reply(id, QUICK)
  assert.equal(reply.outcome, 'started', JSON.stringify(reply))
  await endOfTurn(engine, id)

  const turns = await argvOf(stateDir, id)
  assert.equal(turns.length, 2)
  assert.equal(turns[1]?.includes('--agent'), false, 'the reply resumes: the thread already is the agent')
  assert.ok(turns[1]?.includes('--resume'))
  // patchMeta ran when the turn ended, twice: the field has to survive both.
  assert.equal((await store.readMeta(id))?.agent, 'code-reviewer')
  assert.equal(JSON.parse(await readFile(sessionPaths(stateDir).metaFile(id), 'utf8')).agent, 'code-reviewer')
  await engine.stop()
})

test('an agent the CLI did not announce, or a list not known yet, is rejected with its reason (criterion 8)', async () => {
  const unknown = await world()
  const early = await unknown.engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false, agent: 'code-reviewer' })
  assert.deepEqual(early, { outcome: 'rejected', reason: 'the list of agents is not known yet' })

  const { engine } = await worldWithList()
  const missing = await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false, agent: 'x' })
  assert.deepEqual(missing, { outcome: 'rejected', reason: 'no agent "x" in the list the CLI announced' })
  // A rejection leaves no lock behind: the same site launches next.
  assert.equal((await engine.launch({ siteId: 'work', entryId: 'free', text: QUICK, force: false })).outcome, 'started')
  await unknown.engine.stop()
  await engine.stop()
})

test('an agent with an entry that is not a free prompt is rejected (criterion 9)', async () => {
  const { engine } = await worldWithList()
  const result = await engine.launch({ siteId: 'work', entryId: 'review', text: QUICK, force: false, agent: 'code-reviewer' })
  assert.deepEqual(result, { outcome: 'rejected', reason: 'an agent can only be launched with a free-prompt entry' })
  await engine.stop()
})

test('a launch without an agent has no --agent and an undefined meta.agent (criterion 10)', async () => {
  const { engine, stateDir, store } = await worldWithList()
  const id = await finished(engine, 'work', QUICK)
  const [first] = await argvOf(stateDir, id)
  assert.equal(first?.includes('--agent'), false)
  assert.equal((await store.readMeta(id))?.agent, undefined)
  await engine.stop()
})
