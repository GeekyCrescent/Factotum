import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { CRASH_REASON, ORPHAN_REASON, reconcile } from './lifecycle.ts'
import { SiteLocks } from './locks.ts'
import { sessionPaths } from './paths.ts'
import { SessionStore } from './store.ts'

const AT = '2026-09-15T00:00:00.000Z'
const NOW = () => new Date(AT)

function silentLog() {
  const lines: string[] = []
  return {
    log: {
      info: (m: string) => lines.push(`info ${m}`),
      warn: (m: string) => lines.push(`warn ${m}`),
      error: (m: string) => lines.push(`error ${m}`),
    },
    lines,
  }
}

async function world(daemonPid = 4242) {
  const stateDir = await mkdtemp(join(tmpdir(), 'factotum-recon-'))
  const paths = sessionPaths(stateDir)
  const store = new SessionStore(paths, NOW)
  await store.ensureRoots()
  return { paths, store, locks: new SiteLocks(paths, daemonPid) }
}

const sid = (n: number) => `019965aa-0000-7000-8000-00000000000${n}`

/** A real, harmless process group to stand in for a `claude` that outlived us. */
function sleeper(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached: true, stdio: 'ignore' })
}

// ---------------------------------------------------------------------------
// Row 1 — another daemon holds this environment
// ---------------------------------------------------------------------------

test('a lock held by a LIVE daemon pid stops reconciliation and touches nothing', async () => {
  const { store, locks } = await world(process.pid)
  await store.create({ id: sid(1), siteId: 'work', entryId: 'free', startedAt: AT, sitePath: undefined, agent: undefined, prompt: undefined })
  await locks.acquire('work', sid(1), AT)
  const { log, lines } = silentLog()

  await reconcile({ store, locks, log, now: NOW })

  // The lock is still there and the session is untouched: fighting over locks with
  // another live daemon is the worst available move.
  assert.notEqual(await locks.heldBy('work'), undefined)
  assert.equal((await store.readMeta(sid(1)))?.state, 'running')
  assert.match(lines.join('\n'), /another daemon may own/)
})

// ---------------------------------------------------------------------------
// Row 2 — the agent outlived the daemon. THE ORDER IS THE POINT.
// ---------------------------------------------------------------------------

test('a running session whose agent is ALIVE: the group is killed FIRST, then failed, then released', async () => {
  const { store, locks } = await world(999_999)
  await store.create({ id: sid(2), siteId: 'work', entryId: 'free', startedAt: AT, sitePath: undefined, agent: undefined, prompt: undefined })
  await store.patchMeta(sid(2), (m) => ({ ...m, agentPid: 12_345 }))
  await locks.acquire('work', sid(2), AT)

  const order: string[] = []
  const { log } = silentLog()
  await reconcile({
    store,
    locks: {
      all: () => locks.all(),
      releaseEntry: async (entry) => {
        order.push('release')
        await locks.releaseEntry(entry)
      },
    },
    log,
    now: NOW,
    alive: (pid) => pid === 12_345,
    killGroup: () => order.push('kill'),
  })

  // Releasing before killing would let a second agent into the same repository while
  // the old one is still writing to it. That is risk 18.
  assert.deepEqual(order, ['kill', 'release'])
  const meta = await store.readMeta(sid(2))
  assert.equal(meta?.state, 'failed')
  assert.equal(meta?.reason, ORPHAN_REASON)
  assert.equal(meta?.agentPid, undefined)
  assert.equal(await locks.heldBy('work'), undefined)
})

test('the orphan kill reaches a REAL process group, negative pid and all', async () => {
  // The negative pid is the group, not the process. A fake would not prove that.
  const { store, locks } = await world(999_999)
  const child = sleeper()
  const pid = child.pid
  assert.notEqual(pid, undefined)

  await store.create({ id: sid(3), siteId: 'work', entryId: 'free', startedAt: AT, sitePath: undefined, agent: undefined, prompt: undefined })
  await store.patchMeta(sid(3), (m) => ({ ...m, agentPid: pid }))
  await locks.acquire('work', sid(3), AT)

  const { log } = silentLog()
  await reconcile({ store, locks, log, now: NOW })

  const exited = await new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true)
    child.once('exit', () => resolve(true))
    setTimeout(() => resolve(false), 5_000).unref()
  })
  assert.equal(exited, true)
  assert.equal((await store.readMeta(sid(3)))?.reason, ORPHAN_REASON)
})

test('an agent that died between the check and the signal still closes the session', async () => {
  const { store, locks } = await world(999_999)
  await store.create({ id: sid(4), siteId: 'work', entryId: 'free', startedAt: AT, sitePath: undefined, agent: undefined, prompt: undefined })
  await store.patchMeta(sid(4), (m) => ({ ...m, agentPid: 777 }))
  await locks.acquire('work', sid(4), AT)

  const { log } = silentLog()
  await reconcile({
    store,
    locks,
    log,
    now: NOW,
    alive: (pid) => pid === 777,
    killGroup: () => {
      throw new Error('ESRCH')
    },
  })

  assert.equal((await store.readMeta(sid(4)))?.state, 'failed')
  assert.equal(await locks.heldBy('work'), undefined)
})

// ---------------------------------------------------------------------------
// Row 3 — running, but the agent is gone
// ---------------------------------------------------------------------------

test('a running session whose agent is dead becomes failed with a reason, then the lock goes', async () => {
  const { store, locks } = await world(999_999)
  await store.create({ id: sid(5), siteId: 'work', entryId: 'free', startedAt: AT, sitePath: undefined, agent: undefined, prompt: undefined })
  await store.patchMeta(sid(5), (m) => ({ ...m, agentPid: 31_337 }))
  await locks.acquire('work', sid(5), AT)

  const { log } = silentLog()
  await reconcile({ store, locks, log, now: NOW, alive: () => false })

  const meta = await store.readMeta(sid(5))
  assert.equal(meta?.state, 'failed')
  assert.equal(meta?.reason, CRASH_REASON)
  assert.equal(await locks.heldBy('work'), undefined)
})

test('the failure is written to the LOG too, so the screen can show it', async () => {
  const { store, locks } = await world(999_999)
  await store.create({ id: sid(6), siteId: 'work', entryId: 'free', startedAt: AT, sitePath: undefined, agent: undefined, prompt: undefined })
  await locks.acquire('work', sid(6), AT)

  const { log } = silentLog()
  await reconcile({ store, locks, log, now: NOW, alive: () => false })

  const page = await store.read(sid(6), 0)
  assert.equal(page.state, 'failed')
  assert.equal(page.events.at(-1)?.kind, 'state')
})

test('the events.jsonl written before the crash is left intact up to its last event', async () => {
  const { store, locks } = await world(999_999)
  await store.create({ id: sid(7), siteId: 'work', entryId: 'free', startedAt: AT, sitePath: undefined, agent: undefined, prompt: undefined })
  await store.append(sid(7), { kind: 'message', role: 'assistant', text: 'made it this far' })
  await locks.acquire('work', sid(7), AT)

  const { log } = silentLog()
  await reconcile({ store, locks, log, now: NOW, alive: () => false })

  const page = await store.read(sid(7), 0)
  assert.deepEqual(page.events.map((e) => e.seq), [0, 1])
  assert.equal(page.events[0]?.kind === 'message' ? page.events[0].text : '', 'made it this far')
})

// ---------------------------------------------------------------------------
// Row 4 — already terminal: an orphaned lock
// ---------------------------------------------------------------------------

test('a lock over an already-terminal session is released and the session is not rewritten', async () => {
  // The daemon died between writing the terminal state and releasing the lock — the
  // second of the two mid-sequence crashes.
  const { store, locks } = await world(999_999)
  await store.create({ id: sid(8), siteId: 'work', entryId: 'free', startedAt: AT, sitePath: undefined, agent: undefined, prompt: undefined })
  await store.patchMeta(sid(8), (m) => ({ ...m, state: 'finished', endedAt: AT, reason: 'all done' }))
  await locks.acquire('work', sid(8), AT)

  const { log } = silentLog()
  await reconcile({ store, locks, log, now: NOW, alive: () => false })

  assert.equal(await locks.heldBy('work'), undefined)
  const meta = await store.readMeta(sid(8))
  assert.equal(meta?.state, 'finished')
  assert.equal(meta?.reason, 'all done')
})

// ---------------------------------------------------------------------------
// Rows 5 and 6 — the first mid-sequence crash: lock taken, no meta yet
// ---------------------------------------------------------------------------

test('a lock whose session directory exists but has NO meta.json is released', async () => {
  // settings.json is written before meta.json, so the directory can already be there.
  const { store, locks, paths } = await world(999_999)
  await mkdir(paths.sessionDir(sid(9)), { recursive: true })
  await writeFile(paths.settingsFile(sid(9)), '{}')
  await locks.acquire('work', sid(9), AT)

  const { log } = silentLog()
  await reconcile({ store, locks, log, now: NOW, alive: () => false })
  assert.equal(await locks.heldBy('work'), undefined)
})

test('a lock whose session has no directory at all is released', async () => {
  const { store, locks } = await world(999_999)
  await locks.acquire('work', sid(1), AT)

  const { log } = silentLog()
  await reconcile({ store, locks, log, now: NOW, alive: () => false })
  assert.equal(await locks.heldBy('work'), undefined)
})

test('a lock whose meta.json is TRUNCATED is released instead of holding every site hostage', async () => {
  const { store, locks, paths } = await world(999_999)
  await store.create({ id: sid(2), siteId: 'work', entryId: 'free', startedAt: AT, sitePath: undefined, agent: undefined, prompt: undefined })
  await writeFile(paths.metaFile(sid(2)), '{"id":"019965aa-0000')
  await locks.acquire('work', sid(2), AT)

  const { log } = silentLog()
  await reconcile({ store, locks, log, now: NOW, alive: () => false })
  assert.equal(await locks.heldBy('work'), undefined)
})

test('an UNREADABLE lock file is released rather than left for ever', async () => {
  const { store, locks, paths } = await world(999_999)
  await writeFile(paths.lockFile('work'), 'not json at all')

  const { log } = silentLog()
  await reconcile({ store, locks, log, now: NOW, alive: () => false })
  assert.equal(await locks.heldBy('work'), undefined)
})

// ---------------------------------------------------------------------------
// Several at once
// ---------------------------------------------------------------------------

test('every site is reconciled in one pass, and each keeps its own outcome', async () => {
  const { store, locks } = await world(999_999)
  await store.create({ id: sid(1), siteId: 'a', entryId: 'free', startedAt: AT, sitePath: undefined, agent: undefined, prompt: undefined })
  await store.create({ id: sid(2), siteId: 'b', entryId: 'free', startedAt: AT, sitePath: undefined, agent: undefined, prompt: undefined })
  await store.patchMeta(sid(2), (m) => ({ ...m, state: 'finished' }))
  await locks.acquire('a', sid(1), AT)
  await locks.acquire('b', sid(2), AT)

  const { log } = silentLog()
  await reconcile({ store, locks, log, now: NOW, alive: () => false })

  assert.equal(await locks.heldBy('a'), undefined)
  assert.equal(await locks.heldBy('b'), undefined)
  assert.equal((await store.readMeta(sid(1)))?.state, 'failed')
  assert.equal((await store.readMeta(sid(2)))?.state, 'finished')
})

test('reconciling with no locks at all does nothing and does not complain', async () => {
  const { store, locks } = await world()
  const { log, lines } = silentLog()
  await reconcile({ store, locks, log, now: NOW })
  assert.deepEqual(lines, [])
})

// ---------------------------------------------------------------------------
// Several holders on ONE site (spec 2026-10-03-varias-sesiones-por-proyecto, D3)
// ---------------------------------------------------------------------------

const SHARED = () => 'shared' as const

/** A healthy neighbour: a running session with a dead agent, next to the row under test. */
async function neighbour(store: SessionStore, locks: SiteLocks): Promise<string> {
  const id = sid(0)
  await store.create({ id, siteId: 'work', entryId: 'free', startedAt: AT, sitePath: undefined, agent: undefined, prompt: undefined })
  await locks.acquire('work', id, AT, SHARED)
  return id
}

async function neighbourWasReconciled(store: SessionStore, locks: SiteLocks, id: string): Promise<void> {
  assert.equal((await store.readMeta(id))?.state, 'failed')
  assert.deepEqual(await locks.all(), [])
}

test('row 2 per lock: an orphan next to a neighbour — both closed, both released (criterion 18)', async () => {
  const { store, locks } = await world(999_999)
  const other = await neighbour(store, locks)
  await store.create({ id: sid(2), siteId: 'work', entryId: 'free', startedAt: AT, sitePath: undefined, agent: undefined, prompt: undefined })
  await store.patchMeta(sid(2), (m) => ({ ...m, agentPid: 12_345 }))
  await locks.acquire('work', sid(2), AT, SHARED)
  const killed: number[] = []

  const { log } = silentLog()
  await reconcile({ store, locks, log, now: NOW, alive: (pid) => pid === 12_345, killGroup: (pid) => killed.push(pid) })

  assert.deepEqual(killed, [12_345])
  assert.equal((await store.readMeta(sid(2)))?.reason, ORPHAN_REASON)
  await neighbourWasReconciled(store, locks, other)
})

test('row 3 per lock: two running sessions with dead agents on one site both fail (criterion 18)', async () => {
  const { store, locks } = await world(999_999)
  const other = await neighbour(store, locks)
  await store.create({ id: sid(5), siteId: 'work', entryId: 'free', startedAt: AT, sitePath: undefined, agent: undefined, prompt: undefined })
  await locks.acquire('work', sid(5), AT, SHARED)

  const { log } = silentLog()
  await reconcile({ store, locks, log, now: NOW, alive: () => false })

  assert.equal((await store.readMeta(sid(5)))?.reason, CRASH_REASON)
  await neighbourWasReconciled(store, locks, other)
})

test('row 4 per lock: a terminal session next to a running one — released, not rewritten (criterion 18)', async () => {
  const { store, locks } = await world(999_999)
  const other = await neighbour(store, locks)
  await store.create({ id: sid(8), siteId: 'work', entryId: 'free', startedAt: AT, sitePath: undefined, agent: undefined, prompt: undefined })
  await store.patchMeta(sid(8), (m) => ({ ...m, state: 'finished', endedAt: AT, reason: 'all done' }))
  await locks.acquire('work', sid(8), AT, SHARED)

  const { log } = silentLog()
  await reconcile({ store, locks, log, now: NOW, alive: () => false })

  assert.equal((await store.readMeta(sid(8)))?.reason, 'all done')
  await neighbourWasReconciled(store, locks, other)
})

test('rows 5 and 6 per lock: no meta, and an unreadable holder file, next to a neighbour (criterion 18)', async () => {
  const { store, locks, paths } = await world(999_999)
  const other = await neighbour(store, locks)
  await locks.acquire('work', sid(9), AT, SHARED)
  await writeFile(paths.holderFile('work', 'torn'), 'not json at all')

  const { log } = silentLog()
  await reconcile({ store, locks, log, now: NOW, alive: () => false })

  await neighbourWasReconciled(store, locks, other)
})

test('three running sessions on one shared site: three failed, three notices, nothing left (criterion 17)', async () => {
  const { store, locks, paths } = await world(999_999)
  for (const n of [1, 2, 3]) {
    await store.create({ id: sid(n), siteId: 'work', entryId: 'free', startedAt: AT, sitePath: undefined, agent: undefined, prompt: undefined })
    await locks.acquire('work', sid(n), AT, SHARED)
  }
  const announced: string[] = []

  const { log } = silentLog()
  await reconcile({ store, locks, log, now: NOW, alive: () => false, announce: (id) => announced.push(id) })

  for (const n of [1, 2, 3]) assert.equal((await store.readMeta(sid(n)))?.state, 'failed')
  assert.deepEqual(announced.sort(), [sid(1), sid(2), sid(3)])
  assert.deepEqual(await locks.all(), [])
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(paths.locks), [])
})

test('an OLD-layout lock over a running session is reconciled by the same rows and released (criterion 19)', async () => {
  const { store, locks, paths } = await world(999_999)
  await store.create({ id: sid(4), siteId: 'work', entryId: 'free', startedAt: AT, sitePath: undefined, agent: undefined, prompt: undefined })
  await writeFile(paths.lockFile('work'), JSON.stringify({ siteId: 'work', sessionId: sid(4), pid: 999_999, acquiredAt: AT }))

  const { log } = silentLog()
  await reconcile({ store, locks, log, now: NOW, alive: () => false })

  assert.equal((await store.readMeta(sid(4)))?.state, 'failed')
  assert.deepEqual(await locks.all(), [])
})

test('ONE live daemon pid among several locks aborts before releasing ANY of them (criterion 20)', async () => {
  const { store, locks, paths } = await world(999_999)
  // Two sites the dead daemon left, sorted BEFORE the live one so a lazy loop would release them first.
  await locks.acquire('a', sid(1), AT)
  await locks.acquire('b', sid(2), AT, SHARED)
  await mkdir(paths.lockDir('z'), { recursive: true })
  await writeFile(paths.holderFile('z', sid(3)), JSON.stringify({ siteId: 'z', sessionId: sid(3), pid: 4242, acquiredAt: AT }))
  let released = 0

  const { log, lines } = silentLog()
  await reconcile({
    store,
    locks: { all: () => locks.all(), releaseEntry: async () => void (released += 1) },
    log,
    now: NOW,
    alive: (pid) => pid === 4242,
  })

  assert.equal(released, 0)
  assert.equal((await locks.all()).length, 3)
  assert.match(lines.join('\n'), /another daemon may own/)
})
