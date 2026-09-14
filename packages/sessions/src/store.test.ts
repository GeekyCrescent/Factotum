import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionPaths } from './paths.ts'
import { SessionStore } from './store.ts'
import type { EventInput } from './types.ts'

/**
 * A clock that ticks one second per reading. The store must take `at` from THIS and
 * never from `new Date()`, which is what lets the order be asserted without waiting
 * for it.
 */
function fakeClock(): () => Date {
  let ms = Date.parse('2026-09-15T00:00:00.000Z')
  return () => {
    const now = new Date(ms)
    ms += 1_000
    return now
  }
}

async function freshStore(): Promise<{ store: SessionStore; paths: ReturnType<typeof sessionPaths> }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'factotum-store-'))
  const paths = sessionPaths(stateDir)
  const store = new SessionStore(paths, fakeClock())
  await store.ensureRoots()
  return { store, paths }
}

const ID = '019965aa-0000-7000-8000-000000000001'

async function started(store: SessionStore, id = ID) {
  return await store.create({ id, siteId: 'work', entryId: 'free', startedAt: '2026-09-15T00:00:00.000Z' })
}

const msg = (text: string): EventInput => ({ kind: 'message', role: 'assistant', text })

// ---------------------------------------------------------------------------
// seq — criterion 7: contiguous from 0, no gaps, no duplicates
// ---------------------------------------------------------------------------

test('seq starts at 0 and is contiguous', async () => {
  const { store } = await freshStore()
  await started(store)
  for (let i = 0; i < 5; i += 1) await store.append(ID, msg(`m${i}`))

  const page = await store.read(ID, 0)
  assert.deepEqual(page.events.map((e) => e.seq), [0, 1, 2, 3, 4])
})

test('CONCURRENT appends still produce contiguous seq with no duplicates', async () => {
  // The write queue is what makes this true: without it, two appends read the same
  // next seq and the log grows two events that claim to be the same one.
  const { store } = await freshStore()
  await started(store)

  await Promise.all(Array.from({ length: 25 }, (_, i) => store.append(ID, msg(`m${i}`))))

  const page = await store.read(ID, 0)
  const seqs = page.events.map((e) => e.seq)
  assert.deepEqual(seqs, Array.from({ length: 25 }, (_, i) => i))
  assert.equal(new Set(seqs).size, 25)
})

test('the `at` comes from the injected clock, never the wall clock', async () => {
  const { store } = await freshStore()
  await started(store)
  const first = await store.append(ID, msg('a'))
  const second = await store.append(ID, msg('b'))
  assert.equal(first.at, '2026-09-15T00:00:00.000Z')
  assert.equal(second.at, '2026-09-15T00:00:01.000Z')
})

test('an event is on disk BEFORE append resolves', async () => {
  // Disk first, memory after. The other way round, a crash between the two loses the
  // event for good and no client can recover it.
  const { store, paths } = await freshStore()
  await started(store)
  await store.append(ID, msg('durable'))
  const text = await readFile(paths.eventsFile(ID), 'utf8')
  assert.match(text, /durable/)
})

test('seq survives a restart, because it is derived from the log and not remembered', async () => {
  const { store, paths } = await freshStore()
  await started(store)
  await store.append(ID, msg('a'))
  await store.append(ID, msg('b'))

  const reopened = new SessionStore(paths, fakeClock())
  const next = await reopened.append(ID, msg('c'))
  assert.equal(next.seq, 2)
})

// ---------------------------------------------------------------------------
// read — the cursor
// ---------------------------------------------------------------------------

test('reading from an intermediate cursor repeats nothing and skips nothing', async () => {
  const { store } = await freshStore()
  await started(store)
  for (let i = 0; i < 6; i += 1) await store.append(ID, msg(`m${i}`))

  const first = await store.read(ID, 0)
  assert.equal(first.nextSeq, 6)

  const middle = await store.read(ID, 3)
  assert.deepEqual(middle.events.map((e) => e.seq), [3, 4, 5])
  assert.equal(middle.nextSeq, 6)
})

test('reading from the end returns nothing and the same cursor, which is how polling idles', async () => {
  const { store } = await freshStore()
  await started(store)
  await store.append(ID, msg('only'))

  const page = await store.read(ID, 1)
  assert.deepEqual(page.events, [])
  assert.equal(page.nextSeq, 1)
})

test('a truncated last line is skipped and the lines before it still read', async () => {
  const { store, paths } = await freshStore()
  await started(store)
  await store.append(ID, msg('kept'))
  await appendFile(paths.eventsFile(ID), '{"seq":1,"at":"x","kind":"mess')

  const page = await store.read(ID, 0)
  assert.deepEqual(page.events.map((e) => e.seq), [0])
})

test('the state on a page comes from the log, and falls back to the meta', async () => {
  const { store } = await freshStore()
  await started(store)
  assert.equal((await store.read(ID, 0)).state, 'running')

  await store.append(ID, { kind: 'state', state: 'finished', reason: undefined })
  assert.equal((await store.read(ID, 0)).state, 'finished')
})

// ---------------------------------------------------------------------------
// meta — written atomically, and never able to throw on the way in
// ---------------------------------------------------------------------------

test('create writes a running session with no end and no agent pid yet', async () => {
  const { store } = await freshStore()
  const meta = await started(store)
  assert.equal(meta.state, 'running')
  assert.equal(meta.turns, 1)
  assert.equal(meta.agentPid, undefined)
  assert.deepEqual(await store.readMeta(ID), meta)
})

test('patchMeta is a read-modify-write that holds the turn for the whole of it', async () => {
  const { store } = await freshStore()
  await started(store)

  await Promise.all([
    store.patchMeta(ID, (m) => ({ ...m, turns: m.turns + 1 })),
    store.patchMeta(ID, (m) => ({ ...m, turns: m.turns + 1 })),
    store.patchMeta(ID, (m) => ({ ...m, turns: m.turns + 1 })),
  ])

  // 1 + 3. A read-modify-write without the turn loses updates here.
  assert.equal((await store.readMeta(ID))?.turns, 4)
})

test('meta.json is written through a temp file, so a reader never sees half of it', async () => {
  const { store, paths } = await freshStore()
  await started(store)
  const text = await readFile(paths.metaFile(ID), 'utf8')
  assert.doesNotThrow(() => JSON.parse(text))
  // And the temp name is not what ends up in place.
  assert.equal(paths.metaFile(ID).endsWith('.tmp'), false)
})

test('a TRUNCATED meta.json reads as undefined instead of throwing', async () => {
  // This is load-bearing. `reconcile()` runs inside `start()`, and one unparseable
  // meta that threw would disable the module and hold EVERY lock for every site.
  const { store, paths } = await freshStore()
  await started(store)
  await writeFile(paths.metaFile(ID), '{"id":"019965aa-0000-7000-8000-0000000')
  assert.equal(await store.readMeta(ID), undefined)
})

test('a meta.json that is valid JSON but not a session reads as undefined', async () => {
  const { store, paths } = await freshStore()
  await started(store)
  await writeFile(paths.metaFile(ID), '{"hello":"world"}')
  assert.equal(await store.readMeta(ID), undefined)
})

test('patching a session that has no readable meta returns undefined rather than inventing one', async () => {
  const { store } = await freshStore()
  assert.equal(await store.patchMeta('019965aa-0000-7000-8000-00000000ffff', (m) => m), undefined)
})

// ---------------------------------------------------------------------------
// listIds — ordered by id, which is ordered by time because the ids are UUIDv7
// ---------------------------------------------------------------------------

test('sessions list newest first, by id, with no in-memory index', async () => {
  const { store } = await freshStore()
  await store.create({ id: '019965aa-0000-7000-8000-000000000001', siteId: 'a', entryId: 'free', startedAt: 'x' })
  await store.create({ id: '019965ab-0000-7000-8000-000000000002', siteId: 'a', entryId: 'free', startedAt: 'x' })
  await store.create({ id: '019965ac-0000-7000-8000-000000000003', siteId: 'a', entryId: 'free', startedAt: 'x' })

  assert.deepEqual(await store.listIds(), [
    '019965ac-0000-7000-8000-000000000003',
    '019965ab-0000-7000-8000-000000000002',
    '019965aa-0000-7000-8000-000000000001',
  ])
})

test('listing an empty store is empty, not an error', async () => {
  const { store } = await freshStore()
  assert.deepEqual(await store.listIds(), [])
})

test('a rejected write does not poison the queue for the next caller', async () => {
  const { store } = await freshStore()
  await started(store)
  await assert.rejects(() =>
    store.patchMeta(ID, () => {
      throw new Error('the patch itself blew up')
    }),
  )
  // The next caller still gets its turn.
  const after = await store.append(ID, msg('still working'))
  assert.equal(after.seq, 0)
})
