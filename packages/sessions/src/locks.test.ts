import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
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
  await locks.release('work')
  assert.deepEqual(await locks.acquire('work', 's2', AT), { ok: true })
})

test('releasing a lock nobody holds is not an error', async () => {
  const { locks } = await fresh()
  await assert.doesNotReject(() => locks.release('never-locked'))
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
