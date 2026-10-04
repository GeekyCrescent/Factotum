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
