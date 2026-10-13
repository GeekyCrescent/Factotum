import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionIndex } from './index-cache.ts'
import { sessionPaths } from './paths.ts'
import { SessionStore } from './store.ts'

const A = '019965aa-0000-7000-8000-00000000000a'
const B = '019965ab-0000-7000-8000-00000000000b'

async function storeWith(ids: readonly string[]): Promise<SessionStore> {
  const store = new SessionStore(sessionPaths(await mkdtemp(join(tmpdir(), 'factotum-index-'))), () => new Date())
  await store.ensureRoots()
  for (const id of ids) {
    await store.create({ id, siteId: id === A ? 'a' : 'b', entryId: 'free', startedAt: new Date().toISOString(), sitePath: undefined, agent: undefined, prompt: undefined })
  }
  return store
}

// ---------------------------------------------------------------------------
// The order of the history: the last interaction first
// ---------------------------------------------------------------------------

test('THE LAST INTERACTION FIRST, not the newest conversation: a reply to the older one lifts it', async () => {
  const store = await storeWith([A, B])
  const index = new SessionIndex()
  await index.build(store)
  assert.deepEqual(index.all().map((m) => m.id), [B, A], 'created later, so first while neither was replied to')

  // What `reply` writes, and nothing else: A is the older conversation and the one just written into.
  store.observe({ written: (m) => index.put(m), removed: (id) => index.drop(id) })
  await store.patchMeta(A, (m) => ({ ...m, touchedAt: '2099-01-01T00:00:00.000Z' }))
  assert.deepEqual(index.all().map((m) => m.id), [A, B])
})

test('a meta from before the field is ordered by the end of its last turn, against one that has it', async () => {
  const store = await storeWith([A, B])
  const index = new SessionIndex()
  // A: no `touchedAt`, a turn that ended late. B: created later, written into early.
  await store.patchMeta(A, (m) => ({ ...m, touchedAt: undefined, endedAt: '2026-10-10T00:00:00.000Z' }))
  await store.patchMeta(B, (m) => ({ ...m, touchedAt: '2026-10-01T00:00:00.000Z' }))
  await index.build(store)
  assert.deepEqual(index.all().map((m) => m.id), [A, B])
})

test('TWO TOUCHED IN THE SAME INSTANT fall back to the id — UUIDv7, so creation order', async () => {
  const store = await storeWith([A, B])
  const index = new SessionIndex()
  const same = '2026-10-14T00:00:00.000Z'
  for (const id of [A, B]) await store.patchMeta(id, (m) => ({ ...m, touchedAt: same }))
  await index.build(store)
  assert.deepEqual(index.all().map((m) => m.id), [B, A])
})

test('the index reads every meta once, newest first, and is ready after', async () => {
  const store = await storeWith([A, B])
  const index = new SessionIndex()
  assert.equal(index.ready, false)
  await index.build(store)
  assert.equal(index.ready, true)
  assert.deepEqual(index.all().map((m) => m.id), [B, A])
  assert.deepEqual(index.bySite('a').map((m) => m.id), [A])
})

test('KEPT IN STEP BY THE STORE: what is written is seen, what is removed is gone (criterion 37)', async () => {
  const store = await storeWith([A])
  const index = new SessionIndex()
  store.observe({ written: (m) => index.put(m), removed: (id) => index.drop(id) })
  await index.build(store)
  await store.patchMeta(A, (m) => ({ ...m, state: 'failed' }))
  assert.equal(index.get(A)?.state, 'failed')
  await store.remove(A, () => false)
  assert.equal(index.get(A), undefined)
})

test('a meta the store wrote before the build is not overwritten by an older read', async () => {
  const store = await storeWith([A])
  const index = new SessionIndex()
  index.put({ ...(await store.readMeta(A))!, title: 'newer' })
  await index.build(store)
  assert.equal(index.get(A)?.title, 'newer')
})
