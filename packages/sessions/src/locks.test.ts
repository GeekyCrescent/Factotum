import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAlive, SiteLocks } from './locks.ts'
import { sessionPaths } from './paths.ts'
import { SessionStore } from './store.ts'

async function fresh(pid = 4242) {
  const stateDir = await mkdtemp(join(tmpdir(), 'factotum-locks-'))
  const paths = sessionPaths(stateDir)
  await new SessionStore(paths, () => new Date()).ensureRoots()
  return { paths, locks: new SiteLocks(paths, pid) }
}

const AT = '2026-09-15T00:00:00.000Z'

test('an uncontested lock is taken', async () => {
  const { locks } = await fresh()
  assert.deepEqual(await locks.acquire('work', 's1', AT), { ok: true })
})

// ---------------------------------------------------------------------------
// C2 — two at once: one wins, the other is told who holds it
// ---------------------------------------------------------------------------

test('two simultaneous acquires on one site: exactly one wins', async () => {
  const { locks } = await fresh()

  const [a, b] = await Promise.all([locks.acquire('work', 's1', AT), locks.acquire('work', 's2', AT)])
  const results = [a, b]

  assert.equal(results.filter((r) => r.ok).length, 1)
  const loser = results.find((r) => !r.ok)
  assert.notEqual(loser, undefined)
  // The loser learns WHICH session has it, which is what the 409 body needs.
  assert.equal(loser?.ok, false)
  assert.match(loser?.ok === false ? (loser.heldBy?.sessionId ?? '') : '', /^s[12]$/)
})

test('the loser is told the session id, not just that it failed', async () => {
  const { locks } = await fresh()
  await locks.acquire('work', 'the-first-one', AT)
  const second = await locks.acquire('work', 'the-second-one', AT)
  assert.equal(second.ok, false)
  assert.equal(second.ok === false ? second.heldBy?.sessionId : undefined, 'the-first-one')
})

test('the lock records the DAEMON pid, which is not the agent pid', async () => {
  const { locks } = await fresh(9911)
  await locks.acquire('work', 's1', AT)
  assert.equal((await locks.heldBy('work'))?.pid, 9911)
})

test('two different sites do not contend', async () => {
  const { locks } = await fresh()
  assert.deepEqual(await locks.acquire('a', 's1', AT), { ok: true })
  assert.deepEqual(await locks.acquire('b', 's2', AT), { ok: true })
})

test('a released lock can be taken again, which is what the second turn needs', async () => {
  const { locks } = await fresh()
  await locks.acquire('work', 's1', AT)
  await locks.release('work', 's1')
  assert.deepEqual(await locks.acquire('work', 's2', AT), { ok: true })
})

test('releasing a lock nobody holds is not an error', async () => {
  const { locks } = await fresh()
  await assert.doesNotReject(() => locks.release('never-locked', 's1'))
})

test('a lock is NEVER stolen just because its pid is dead', async () => {
  // The predecessor steals here. Not inherited: that pid is the daemon's, it says
  // nothing about whether an agent is still writing, and taking the lock without
  // touching meta.json is the second source of truth that reconciliation exists to
  // avoid. Stealing happens in exactly one place, and that place is reconcile().
  const { locks } = await fresh(999_999)
  await locks.acquire('work', 's1', AT)
  const second = await locks.acquire('work', 's2', AT)
  assert.equal(second.ok, false)
})

test('an unreadable lock file reports no holder rather than throwing', async () => {
  const { paths, locks } = await fresh()
  await writeFile(paths.lockFile('work'), 'not json')
  assert.equal(await locks.heldBy('work'), undefined)
  const result = await locks.acquire('work', 's1', AT)
  assert.deepEqual(result, { ok: false, heldBy: undefined })
})

test('all() lists one entry per site and ignores anything that is not a lock', async () => {
  const { paths, locks } = await fresh()
  await locks.acquire('a', 's1', AT)
  await locks.acquire('b', 's2', AT)
  await writeFile(join(paths.locks, 'README'), 'not a lock')

  const all = await locks.all()
  assert.deepEqual(all.map((entry) => entry.siteId).sort(), ['a', 'b'])
})

test('all() on a missing locks directory is empty, not an error', async () => {
  const locks = new SiteLocks(sessionPaths('/definitely/not/here'))
  assert.deepEqual(await locks.all(), [])
})

// ---------------------------------------------------------------------------
// Shared mode (spec 2026-10-03-varias-sesiones-por-proyecto, D2): one file per holder
// ---------------------------------------------------------------------------

const SHARED = () => 'shared' as const
const EXCLUSIVE = () => 'exclusive' as const

test('two simultaneous SHARED acquires on one site both win, one file each (criterion 1)', async () => {
  const { paths, locks } = await fresh()

  const [a, b] = await Promise.all([locks.acquire('work', 's1', AT, SHARED), locks.acquire('work', 's2', AT, SHARED)])

  assert.deepEqual([a, b], [{ ok: true }, { ok: true }])
  assert.deepEqual((await readdir(join(paths.locks, 'work'))).sort(), ['s1.json', 's2.json'])
})

test('an EXCLUSIVE acquire loses to any holder, and is told the oldest (criterion 2)', async () => {
  const { locks } = await fresh()
  await locks.acquire('work', 's2', '2026-09-15T00:00:02.000Z', SHARED)
  await locks.acquire('work', 's1', '2026-09-15T00:00:01.000Z', SHARED)

  const result = await locks.acquire('work', 's3', AT, EXCLUSIVE)

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.heldBy?.sessionId : undefined, 's1')
  assert.equal((await locks.heldBy('work'))?.sessionId, 's1')
})

test('holders with the same acquiredAt are ordered by session id, so "the oldest" is fixed', async () => {
  const { locks } = await fresh()
  await locks.acquire('work', 'b', AT, SHARED)
  await locks.acquire('work', 'a', AT, SHARED)
  assert.deepEqual((await locks.holders('work')).map((h) => h?.sessionId), ['a', 'b'])
})

test('a SHARED acquire wins next to a holder that came in EXCLUSIVE: the mode is not stored (criterion 3)', async () => {
  const { locks } = await fresh()
  await locks.acquire('work', 's1', AT)
  assert.deepEqual(await locks.acquire('work', 's2', AT, SHARED), { ok: true })
})

test('a SHARED acquire loses to removing, and is told so (criterion 3)', async () => {
  const { locks } = await fresh()
  await locks.acquire('work', 'removing', AT)
  const result = await locks.acquire('work', 's1', AT, SHARED)
  assert.equal(result.ok === false ? result.heldBy?.sessionId : undefined, 'removing')
})

test('the SAME holder twice at once: exactly one wins, the other is told that holder (criterion 4)', async () => {
  const { locks } = await fresh()
  const [a, b] = await Promise.all([locks.acquire('work', 's1', AT, SHARED), locks.acquire('work', 's1', AT, SHARED)])
  const results = [a, b]
  assert.equal(results.filter((r) => r.ok).length, 1)
  const loser = results.find((r) => !r.ok)
  assert.equal(loser?.ok === false ? loser.heldBy?.sessionId : undefined, 's1')
})

test('releasing one holder of three leaves the other two (criterion 5)', async () => {
  const { locks } = await fresh()
  for (const id of ['s1', 's2', 's3']) await locks.acquire('work', id, AT, SHARED)

  await locks.release('work', 's2')

  assert.deepEqual((await locks.holders('work')).map((h) => h?.sessionId), ['s1', 's3'])
})

test('heldBy names someone until the LAST of three is released, then the directory is gone (criterion 6b)', async () => {
  const { paths, locks } = await fresh()
  for (const id of ['s1', 's2', 's3']) await locks.acquire('work', id, AT, SHARED)

  await locks.release('work', 's1')
  await locks.release('work', 's2')
  assert.equal((await locks.heldBy('work'))?.sessionId, 's3')
  await locks.release('work', 's3')

  assert.equal(await locks.heldBy('work'), undefined)
  assert.deepEqual(await readdir(paths.locks), [])
})

test('an OLD-layout lock makes both modes lose, heldBy names it, and all() lists it (criterion 6)', async () => {
  const { paths, locks } = await fresh()
  await writeFile(paths.lockFile('work'), JSON.stringify({ siteId: 'work', sessionId: 'old', pid: 1, acquiredAt: AT }))

  const shared = await locks.acquire('work', 's1', AT, SHARED)
  const exclusive = await locks.acquire('work', 's2', AT, EXCLUSIVE)

  assert.equal(shared.ok === false ? shared.heldBy?.sessionId : undefined, 'old')
  assert.equal(exclusive.ok === false ? exclusive.heldBy?.sessionId : undefined, 'old')
  assert.equal((await locks.heldBy('work'))?.sessionId, 'old')
  assert.deepEqual(
    (await locks.all()).map((e) => [e.siteId, e.holderId, e.info?.sessionId]),
    [['work', undefined, 'old']],
  )
})

test('releaseEntry releases an old-layout lock by its layout', async () => {
  const { paths, locks } = await fresh()
  await writeFile(paths.lockFile('work'), JSON.stringify({ siteId: 'work', sessionId: 'old', pid: 1, acquiredAt: AT }))
  const [entry] = await locks.all()
  assert.notEqual(entry, undefined)
  if (entry !== undefined) await locks.releaseEntry(entry)
  assert.deepEqual(await locks.all(), [])
})

test('an unreadable file INSIDE the site directory: no holder, exclusive loses, shared wins', async () => {
  const { paths, locks } = await fresh()
  await mkdir(paths.lockDir('work'), { recursive: true })
  await writeFile(paths.holderFile('work', 'torn'), 'not json')

  assert.equal(await locks.heldBy('work'), undefined)
  assert.deepEqual(await locks.acquire('work', 's1', AT, EXCLUSIVE), { ok: false, heldBy: undefined })
  assert.deepEqual(await locks.acquire('work', 's2', AT, SHARED), { ok: true })
})

test('a disk error in one acquire does not break the site queue for the next (criterion 6c)', async () => {
  const { paths, locks } = await fresh()
  // A FILE where the site's directory should be: mkdir fails with something that is not EEXIST-on-the-holder.
  await writeFile(paths.lockDir('work'), 'in the way')

  await assert.rejects(() => locks.acquire('work', 's1', AT, SHARED))

  // The obstacle is cleared; the queue must not have kept the rejection.
  const { unlink } = await import('node:fs/promises')
  await unlink(paths.lockDir('work'))
  assert.deepEqual(await locks.acquire('work', 's2', AT, SHARED), { ok: true })
})

test('a site directory that cannot be READ fails CLOSED: acquire rejects instead of seeing no holders', async () => {
  const { paths, locks } = await fresh()
  await locks.acquire('work', 's1', AT)
  const { chmod } = await import('node:fs/promises')
  await chmod(paths.lockDir('work'), 0o000)
  try {
    await assert.rejects(() => locks.acquire('work', 's2', AT), /EACCES/)
    await assert.rejects(() => locks.holders('work'), /EACCES/)
  } finally {
    await chmod(paths.lockDir('work'), 0o755)
  }
  // And the queue survived it.
  assert.equal((await locks.acquire('work', 's3', AT)).ok, false)
})

test('all() lists one entry per holder in the new layout, and drops an empty site directory', async () => {
  const { paths, locks } = await fresh()
  await locks.acquire('work', 's1', AT, SHARED)
  await locks.acquire('work', 's2', AT, SHARED)
  await mkdir(paths.lockDir('empty'), { recursive: true })

  const all = await locks.all()

  assert.deepEqual(all.map((e) => [e.siteId, e.holderId]).sort(), [['work', 's1'], ['work', 's2']])
  assert.deepEqual((await readdir(paths.locks)).sort(), ['work'])
})

// ---------------------------------------------------------------------------
// isAlive — asks, never kills
// ---------------------------------------------------------------------------

test('this process is alive', () => {
  assert.equal(isAlive(process.pid), true)
})

test('a pid that cannot exist is not alive', () => {
  assert.equal(isAlive(0), false)
  assert.equal(isAlive(-1), false)
  assert.equal(isAlive(2 ** 30), false)
})
