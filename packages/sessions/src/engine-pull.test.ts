/**
 * The pull before launching (spec 2026-10-07-dos-hosts, D5; criteria 18–21b), through the engine with
 * the fake CLI and REAL repositories: a bare remote, the site, and another clone that pushes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Timers } from '@factotum/core'
import { createEngine } from './engine.ts'
import { checkFreshness, pullIfSafe, type FreshnessDeps, type PullDeps, type PullOutcome } from './freshness.ts'
import { SiteLocks } from './locks.ts'
import { sessionPaths } from './paths.ts'
import { memoryRegistry } from './test-registry.ts'
import { commitIn, git, head, pushFromOther, remoteWithClones, upstream, type Remote } from './test-git.ts'
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
const QUICK = 'quick'
const LINGER = 'linger'

interface Options {
  readonly freshness?: (deps: FreshnessDeps) => Promise<FreshnessReport>
  readonly pull?: (deps: PullDeps) => Promise<PullOutcome>
}

async function world(site: string, options: Options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'factotum-pull-state-'))
  const setup: EngineSetup = {
    titles: { enabled: false, model: 'haiku', effort: 'low' },
    stateDir,
    registry: memoryRegistry({ sites: [{ id: 'work', path: site }] }),
    home: '/nonexistent-home-for-tests',
    factotumRoot: '/nonexistent-home-for-tests/.factotum',
    installRoot: undefined,
    catalog: CATALOG,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date(),
    timers,
    hookUrl: () => 'http://100.64.0.1:7778',
    notify: { canReach: () => false, send: async () => undefined },
  }
  const engine = await createEngine(setup, {
    bin: FAKE,
    ...(options.freshness === undefined ? {} : { freshness: options.freshness }),
    ...(options.pull === undefined ? {} : { pull: options.pull }),
  })
  return { engine, locks: new SiteLocks(sessionPaths(stateDir)) }
}

const launch = (engine: SessionEngine, text = QUICK, force = false): Promise<LaunchResult> =>
  engine.launch({ siteId: 'work', entryId: 'free', text, force })

function idOf(result: LaunchResult): string {
  assert.equal(result.outcome, 'started', `expected started, got ${JSON.stringify(result)}`)
  return result.outcome === 'started' ? result.sessionId : ''
}

async function page(engine: SessionEngine, id: string): Promise<EventPage> {
  const result = await engine.read(id, 0)
  assert.equal('kind' in result, false)
  return result as EventPage
}

async function userTexts(engine: SessionEngine, id: string): Promise<string[]> {
  return (await page(engine, id)).events.flatMap((e) => (e.kind === 'message' && e.role === 'user' ? [e.text] : []))
}

async function settle(engine: SessionEngine, id: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while ((await page(engine, id)).state === 'running') {
    if (Date.now() > deadline) throw new Error(`session ${id} never settled`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function until(what: string, check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`never: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function behindByOne(): Promise<Remote> {
  const remote = await remoteWithClones()
  await pushFromOther(remote, 1)
  return remote
}

async function setConcurrent(engine: SessionEngine): Promise<void> {
  const change = await engine.updateProject('work', { name: undefined, color: undefined, concurrent: true })
  assert.equal(change.outcome, 'ok')
}

// ---------------------------------------------------------------------------
// Criterion 18 — clean and behind: it advances before the first turn
// ---------------------------------------------------------------------------

test('a clean site N commits behind fast-forwards to @{u}, and the log says "pulled N commits" (criterion 18)', async () => {
  const remote = await remoteWithClones()
  await pushFromOther(remote, 2)
  const { engine } = await world(remote.site)

  const id = idOf(await launch(engine))
  assert.equal(await head(remote.site), await upstream(remote.site))
  const texts = await userTexts(engine, id)
  assert.deepEqual(texts.slice(0, 2), ['pulled 2 commits', QUICK])
  await settle(engine, id)
})

test('a site with no upstream launches as today and leaves NO note (criterion 21b)', async () => {
  const site = await mkdtemp(join(tmpdir(), 'factotum-noup-'))
  await git(site, 'init', '--quiet')
  await commitIn(site, 'a.md', 'a\n')
  const { engine } = await world(site)

  const id = idOf(await launch(engine))
  assert.deepEqual(await userTexts(engine, id), [QUICK])
  await settle(engine, id)
})

// ---------------------------------------------------------------------------
// Criterion 19 — the order of D5
// ---------------------------------------------------------------------------

test('a DIRTY site behind is the 409 stale of today, and NOTHING MOVED (criterion 19)', async () => {
  const remote = await behindByOne()
  await writeFile(join(remote.site, 'README.md'), 'edited\n')
  const before = await head(remote.site)
  const { engine, locks } = await world(remote.site)

  const result = await launch(engine)
  assert.equal(result.outcome, 'stale')
  assert.equal(result.outcome === 'stale' ? result.freshness.pullError : 'x', undefined)
  assert.equal(await head(remote.site), before)
  assert.equal((await locks.holders('work')).length, 0, 'the lock is given back')
})

test('a DIVERGED site is stale with cannot-fast-forward, and nothing moved (criterion 19)', async () => {
  const remote = await behindByOne()
  await commitIn(remote.site, 'mine.md', 'mine\n')
  const before = await head(remote.site)
  const { engine, locks } = await world(remote.site)

  const result = await launch(engine)
  assert.equal(result.outcome, 'stale')
  assert.match(result.outcome === 'stale' ? (result.freshness.pullError ?? '') : '', /^cannot-fast-forward: /)
  assert.equal(await head(remote.site), before)
  assert.equal(await git(remote.site, 'status', '--porcelain'), '')
  assert.equal((await locks.holders('work')).length, 0)
})

test('FORCE on a dirty site touches nothing, and the log says so before the warning (criterion 19, S10)', async () => {
  const remote = await behindByOne()
  await writeFile(join(remote.site, 'README.md'), 'edited\n')
  const before = await head(remote.site)
  const { engine } = await world(remote.site)

  const id = idOf(await launch(engine, QUICK, true))
  assert.equal(await head(remote.site), before)
  const texts = await userTexts(engine, id)
  assert.equal(texts[0], 'not pulled: working tree has changes')
  assert.match(texts[1] ?? '', /^launched over a freshness warning: 1 commit behind the remote; 1 uncommitted file: README\.md/)
  assert.equal(texts[2], QUICK)
  await settle(engine, id)
})

test('FORCE on a clean site behind pulls, and says so — with no warning left to launch over', async () => {
  const remote = await behindByOne()
  const { engine } = await world(remote.site)

  const id = idOf(await launch(engine, QUICK, true))
  assert.equal(await head(remote.site), await upstream(remote.site))
  assert.deepEqual(await userTexts(engine, id), ['pulled 1 commits', QUICK])
  await settle(engine, id)
})

test('FORCE on a diverged site launches, moves nothing, and the log says why it did not pull', async () => {
  const remote = await behindByOne()
  await commitIn(remote.site, 'mine.md', 'mine\n')
  const before = await head(remote.site)
  const { engine } = await world(remote.site)

  const id = idOf(await launch(engine, QUICK, true))
  assert.equal(await head(remote.site), before)
  const texts = await userTexts(engine, id)
  assert.match(texts[0] ?? '', /^not pulled: cannot-fast-forward: /)
  assert.match(texts[1] ?? '', /^launched over a freshness warning: .*cannot-fast-forward/)
  await settle(engine, id)
})

// ---------------------------------------------------------------------------
// Criterion 20 — a fetch that fails does not block
// ---------------------------------------------------------------------------

test('a FETCH THAT FAILS launches without a pull, and the log says "not pulled: fetch failed" (criterion 20)', async () => {
  const remote = await behindByOne()
  await git(remote.site, 'remote', 'set-url', 'origin', join(remote.home, 'gone.git'))
  const before = await head(remote.site)
  const { engine } = await world(remote.site)

  const id = idOf(await launch(engine))
  assert.equal(await head(remote.site), before)
  assert.deepEqual(await userTexts(engine, id), ['not pulled: fetch failed', QUICK])
  await settle(engine, id)
})

// ---------------------------------------------------------------------------
// Criterion 21 — no pull with another session in the project
// ---------------------------------------------------------------------------

test('with another session ALIVE at launch there is no pull, and the line of today says so (criterion 21)', async () => {
  const remote = await behindByOne()
  const { engine } = await world(remote.site)
  await setConcurrent(engine)
  // The first one pulls, then keeps running.
  const first = idOf(await launch(engine, LINGER))
  await pushFromOther(remote, 1)
  const before = await head(remote.site)

  const second = idOf(await launch(engine))
  assert.equal(await head(remote.site), before, 'not pulled under a working session')
  assert.match((await userTexts(engine, second))[0] ?? '', /^freshness not checked: 1 other session\(s\) are running in this project/)
  await engine.cancel(first)
  await settle(engine, second)
})

test('a session that comes in DURING the fetch keeps the merge from running: "pull skipped" (criterion 21)', async () => {
  const remote = await behindByOne()
  const before = await head(remote.site)
  let release: () => void = () => undefined
  const fetched = new Promise<void>((resolve) => {
    release = resolve
  })
  let checks = 0
  const merges: string[] = []
  const { engine } = await world(remote.site, {
    // The real check, held after it finishes: the fetch is "still running" while the second comes in.
    freshness: async (deps) => {
      checks += 1
      const report = await checkFreshness(deps)
      await fetched
      return report
    },
    pull: (deps) =>
      pullIfSafe({
        ...deps,
        git: async (args) => {
          merges.push(args.join(' '))
          return ''
        },
      }),
  })
  await setConcurrent(engine)

  const firstLaunch = launch(engine)
  await until('the first launch is inside its fetch', () => checks === 1)
  // LINGER: still working when the first one reaches its merge.
  const second = idOf(await launch(engine, LINGER))
  release()
  const first = idOf(await firstLaunch)

  assert.deepEqual(merges, [], 'no merge with a second holder')
  assert.equal(await head(remote.site), before)
  assert.deepEqual((await userTexts(engine, first)).slice(0, 2), ['pull skipped: another session is working here', QUICK])
  assert.match((await userTexts(engine, second))[0] ?? '', /^freshness not checked: 1 other session/)
  await engine.cancel(second)
  await settle(engine, first)
  await settle(engine, second)
})

test('TWO SIMULTANEOUS launches in a concurrent project: one merge only, and the second does not start while it runs (criterion 21)', async () => {
  const remote = await behindByOne()
  let release: () => void = () => undefined
  const merging = new Promise<void>((resolve) => {
    release = resolve
  })
  let merges = 0
  let inMerge = false
  const { engine, locks } = await world(remote.site, {
    pull: (deps) =>
      pullIfSafe({
        ...deps,
        git: async (args, _ms, cwd) => {
          merges += 1
          inMerge = true
          await merging
          const out = await git(cwd, ...args)
          inMerge = false
          return out
        },
      }),
  })
  await setConcurrent(engine)

  const firstLaunch = launch(engine)
  await until('the first launch is inside its merge', () => inMerge)
  let secondDone = false
  const secondLaunch = launch(engine).then((result) => {
    secondDone = true
    return result
  })

  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(secondDone, false, 'the second launch waits for the merge')
  assert.equal((await locks.holders('work')).length, 1, 'and has not come into the project')

  release()
  const [first, second] = [idOf(await firstLaunch), idOf(await secondLaunch)]
  assert.equal(merges, 1)
  assert.equal(await head(remote.site), await upstream(remote.site))
  assert.equal((await userTexts(engine, first))[0], 'pulled 1 commits')
  assert.match((await userTexts(engine, second))[0] ?? '', /^freshness not checked: 1 other session/)
  await settle(engine, first)
  await settle(engine, second)
})

test('two launches fired in the same tick: both start, and the merge runs at most once', async () => {
  const remote = await behindByOne()
  let merges = 0
  const { engine } = await world(remote.site, {
    pull: (deps) =>
      pullIfSafe({
        ...deps,
        git: async (args, _ms, cwd) => {
          merges += 1
          return await git(cwd, ...args)
        },
      }),
  })
  await setConcurrent(engine)

  const [a, b] = await Promise.all([launch(engine), launch(engine)])
  const ids = [idOf(a), idOf(b)]
  assert.equal(merges <= 1, true)
  for (const id of ids) await settle(engine, id)
})

// ---------------------------------------------------------------------------
// What the stale report carries
// ---------------------------------------------------------------------------

test('the stale report a failed pull returns carries behind as counted, so the screen says what it was', async () => {
  const remote = await behindByOne()
  await commitIn(remote.site, 'mine.md', 'mine\n')
  const { engine } = await world(remote.site)
  const result = await launch(engine)
  assert.equal(result.outcome === 'stale' ? result.freshness.behind : -1, 1)
  assert.equal(result.outcome === 'stale' ? result.freshness.clean : false, true)
})
