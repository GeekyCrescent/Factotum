/**
 * Several sessions at once in one project (spec 2026-10-03-varias-sesiones-por-proyecto), through the
 * engine with the fake CLI. Apart from `engine.test.ts`, which is long enough already: everything here
 * is about a project whose switch is on, or turned on and off.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Timers } from '@factotum/core'
import { createEngine } from './engine.ts'
import { reconcile } from './lifecycle.ts'
import { SiteLocks } from './locks.ts'
import { sessionPaths } from './paths.ts'
import { SessionStore } from './store.ts'
import { memoryRegistry } from './test-registry.ts'
import type { CatalogEntry, EngineSetup, EventPage, FreshnessReport, LaunchResult, SessionEngine } from './types.ts'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'fake-claude.mjs')

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

const CATALOG: readonly CatalogEntry[] = [{ id: 'free', label: 'Free prompt', invoke: { kind: 'none' } }]
const CLEAN: FreshnessReport = { clean: true, behind: 0, dirtyFiles: [], remoteWarning: undefined }
const DIRTY: FreshnessReport = { clean: false, behind: 0, dirtyFiles: ['sibling-wrote-this.md'], remoteWarning: undefined }

/** The fake CLI keeps a `linger` session running for a minute; `quick` ends at once. */
const LINGER = 'linger'
const QUICK = 'quick'

interface Options {
  readonly repo?: boolean
  readonly freshness?: (deps: { readonly cwd: string }) => Promise<FreshnessReport>
  readonly hookUrl?: () => string
}

async function world(options: Options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'factotum-concurrent-'))
  const stateDir = join(home, 'state')
  const siteDir = join(home, 'site')
  await mkdir(stateDir, { recursive: true })
  await mkdir(siteDir, { recursive: true })
  if (options.repo === true) await promisify(execFile)('git', ['init', '--quiet'], { cwd: siteDir })

  const setup: EngineSetup = {
    titles: { enabled: false, model: 'haiku', effort: 'low' },
    stateDir,
    registry: memoryRegistry({ sites: [{ id: 'work', path: siteDir }] }),
    home: '/nonexistent-home-for-tests',
    factotumRoot: '/nonexistent-home-for-tests/.factotum',
    installRoot: undefined,
    catalog: CATALOG,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date(),
    timers,
    hookUrl: options.hookUrl ?? (() => 'http://100.64.0.1:7778'),
    notify: { canReach: () => false, send: async () => undefined },
  }
  const engine = await createEngine(setup, {
    bin: FAKE,
    ...(options.freshness === undefined ? {} : { freshness: options.freshness }),
  })
  const paths = sessionPaths(stateDir)
  return { engine, paths, stateDir, locks: new SiteLocks(paths), store: new SessionStore(paths, () => new Date()) }
}

async function setConcurrent(engine: SessionEngine, concurrent: boolean): Promise<void> {
  const change = await engine.updateProject('work', { name: undefined, color: undefined, concurrent })
  assert.equal(change.outcome, 'ok')
}

function idOf(result: LaunchResult): string {
  assert.equal(result.outcome, 'started', `expected started, got ${JSON.stringify(result)}`)
  return result.outcome === 'started' ? result.sessionId : ''
}

const launch = (engine: SessionEngine, text: string): Promise<LaunchResult> =>
  engine.launch({ siteId: 'work', entryId: 'free', text, force: false })

async function page(engine: SessionEngine, id: string): Promise<EventPage> {
  const result = await engine.read(id, 0)
  assert.equal('kind' in result, false)
  return result as EventPage
}

async function settle(engine: SessionEngine, id: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while ((await page(engine, id)).state === 'running') {
    if (Date.now() > deadline) throw new Error(`session ${id} never settled`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function cancelAll(engine: SessionEngine, ids: readonly string[]): Promise<void> {
  for (const id of ids) await engine.cancel(id)
}

function userTexts(events: EventPage['events']): string[] {
  return events.flatMap((e) => (e.kind === 'message' && e.role === 'user' ? [e.text] : []))
}

// ---------------------------------------------------------------------------

test('three launches in a concurrent project all start, run at once, and keep their own logs (criterion 7)', async () => {
  const { engine, locks } = await world()
  await setConcurrent(engine, true)

  const ids = [idOf(await launch(engine, `${LINGER} one`)), idOf(await launch(engine, `${LINGER} two`)), idOf(await launch(engine, `${LINGER} three`))]

  for (const id of ids) assert.equal((await page(engine, id)).state, 'running')
  assert.equal((await locks.holders('work')).length, 3)
  const words = ['one', 'two', 'three']
  for (const [i, id] of ids.entries()) assert.deepEqual(userTexts((await page(engine, id)).events), [`${LINGER} ${words[i]}`])
  await cancelAll(engine, ids)
})

test('replying to a finished session while another runs in a concurrent project starts it (criterion 9)', async () => {
  const { engine } = await world()
  await setConcurrent(engine, true)
  const finished = idOf(await launch(engine, QUICK))
  await settle(engine, finished)
  const running = idOf(await launch(engine, LINGER))

  const reply = await engine.reply(finished, QUICK)

  assert.deepEqual(reply, { outcome: 'started', sessionId: finished })
  await settle(engine, finished)
  await cancelAll(engine, [running])
})

test('cancelling one of three leaves the other two running and holding their locks (criterion 10)', async () => {
  const { engine, locks } = await world()
  await setConcurrent(engine, true)
  const ids = [idOf(await launch(engine, LINGER)), idOf(await launch(engine, LINGER)), idOf(await launch(engine, LINGER))]

  await engine.cancel(ids[1] ?? '')

  assert.equal((await page(engine, ids[0] ?? '')).state, 'running')
  assert.equal((await page(engine, ids[2] ?? '')).state, 'running')
  assert.deepEqual((await locks.holders('work')).map((h) => h?.sessionId).sort(), [ids[0], ids[2]].sort())
  await cancelAll(engine, [ids[0] ?? '', ids[2] ?? ''])
})

test('a launch that fails after taking its lock gives back ITS lock and not its sibling’s (criterion 11)', async () => {
  let broken = false
  const { engine, locks } = await world({
    hookUrl: () => {
      if (broken) throw new Error('hook not ready')
      return 'http://100.64.0.1:7778'
    },
  })
  await setConcurrent(engine, true)
  const sibling = idOf(await launch(engine, LINGER))
  broken = true

  await assert.rejects(() => launch(engine, LINGER))

  assert.deepEqual((await locks.holders('work')).map((h) => h?.sessionId), [sibling])
  await cancelAll(engine, [sibling])
})

test('turning the switch OFF with two running cancels nothing, and the next launch and reply are 409 (criterion 13)', async () => {
  const { engine } = await world()
  await setConcurrent(engine, true)
  const finished = idOf(await launch(engine, QUICK))
  await settle(engine, finished)
  const first = idOf(await launch(engine, LINGER))
  const second = idOf(await launch(engine, LINGER))

  await setConcurrent(engine, false)

  assert.equal((await page(engine, first)).state, 'running')
  assert.equal((await page(engine, second)).state, 'running')
  const launched = await launch(engine, QUICK)
  const replied = await engine.reply(finished, QUICK)
  assert.equal(launched.outcome, 'busy')
  assert.equal(replied.outcome, 'busy')
  await cancelAll(engine, [first, second])
})

test('turning the switch ON with one running lets the next one in beside it (criterion 13b)', async () => {
  const { engine } = await world()
  const first = idOf(await launch(engine, LINGER))
  assert.equal((await launch(engine, QUICK)).outcome, 'busy', 'off, as today')

  await setConcurrent(engine, true)
  const second = idOf(await launch(engine, LINGER))

  assert.equal((await page(engine, second)).state, 'running')
  await cancelAll(engine, [first, second])
})

test('a launch beside a sibling still launching does NOT check freshness, and says so (criterion 21)', async () => {
  let calls = 0
  let release: (report: FreshnessReport) => void = () => undefined
  const held = new Promise<FreshnessReport>((resolve) => {
    release = resolve
  })
  const { engine, locks } = await world({
    repo: true,
    freshness: async () => {
      calls += 1
      return await held
    },
  })
  await setConcurrent(engine, true)

  // The first one takes the lock and blocks inside its own freshness check.
  const firstLaunch = launch(engine, QUICK)
  const deadline = Date.now() + 5_000
  while ((await locks.holders('work')).length === 0 || calls === 0) {
    if (Date.now() > deadline) throw new Error('the first launch never reached its freshness check')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const second = idOf(await launch(engine, QUICK))
  release(CLEAN)
  const first = idOf(await firstLaunch)

  assert.equal(calls, 1, 'the second launch did not check')
  assert.match(userTexts((await page(engine, second)).events)[0] ?? '', /^freshness not checked: 1 other session\(s\) are running in this project/)
  await settle(engine, first)
  await settle(engine, second)
})

test('with no sibling, a concurrent project checks freshness as before (criterion 22)', async () => {
  const { engine } = await world({ repo: true, freshness: async () => DIRTY })
  await setConcurrent(engine, true)
  const result = await launch(engine, QUICK)
  assert.equal(result.outcome, 'stale')
})

test('stop with three running leaves three locks, and the next boot releases them all without a second notice (criterion 8b)', async () => {
  const { engine, locks, paths, store } = await world()
  await setConcurrent(engine, true)
  const ids = [idOf(await launch(engine, LINGER)), idOf(await launch(engine, LINGER)), idOf(await launch(engine, LINGER))]

  await engine.stop()

  assert.equal((await locks.holders('work')).length, 3, 'left on purpose, as with one')
  // These locks carry THIS process's pid: `engine.reconcile()` would see a live daemon and stop at
  // row 1, which is what it must do. The next boot is a different process — said with `alive`.
  const announced: string[] = []
  await reconcile({
    store,
    locks: new SiteLocks(paths, 999_999),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date(),
    alive: () => false,
    announce: (id) => announced.push(id),
  })
  assert.deepEqual(await locks.all(), [])
  assert.deepEqual(announced, [])
  for (const id of ids) assert.equal((await store.readMeta(id))?.state, 'cancelled')
})
