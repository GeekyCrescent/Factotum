import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Digest, DigestEntry } from '../types.ts'
import { capturedLog } from '../test-support.ts'
import { DIGEST_ID, openDigestStore } from './store.ts'

function digest(id: string, entries: readonly Partial<DigestEntry>[] = []): Digest {
  return {
    id,
    state: 'ok',
    startedAt: '2026-10-06T07:00:00.000Z',
    endedAt: '2026-10-06T07:00:30.000Z',
    window: { since: '2026-10-04T07:00:00.000Z', until: '2026-10-06T07:00:00.000Z' },
    accounts: [],
    entries: entries as DigestEntry[],
    overflow: 0,
    usage: { batches: 0, failedBatches: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0, model: 'haiku' },
  }
}

async function dir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'factotum-inbox-store-'))
}

test('one file per run, written atomically, 0600, and read back whole (criterion 21)', async () => {
  const where = await dir()
  const store = await openDigestStore(where, capturedLog().log)
  const id = store.nextId(new Date(2026, 9, 6, 8, 12))
  assert.equal(id, '2026-10-06T0812')
  await store.write(digest(id))
  assert.deepEqual(await readdir(where), ['2026-10-06T0812.json'])
  assert.equal((await stat(join(where, `${id}.json`))).mode & 0o777, 0o600)
  assert.deepEqual(await store.get(id), digest(id))
  assert.deepEqual(JSON.parse(await readFile(join(where, `${id}.json`), 'utf8')), digest(id))
})

test('an id taken — on disk or handed out — gets -2, -3, and sorts as a number', async () => {
  const where = await dir()
  await writeFile(join(where, '2026-10-06T0812.json'), JSON.stringify(digest('2026-10-06T0812')))
  const store = await openDigestStore(where, capturedLog().log)
  const at = new Date(2026, 9, 6, 8, 12, 30)
  const ids = Array.from({ length: 10 }, () => store.nextId(at))
  assert.equal(ids[0], '2026-10-06T0812-2')
  assert.equal(ids[9], '2026-10-06T0812-11')
  for (const id of ids) await store.write(digest(id))
  assert.equal((await store.latest())?.id, '2026-10-06T0812-11')
  assert.deepEqual((await store.list(2)).map((summary) => summary.id), ['2026-10-06T0812-11', '2026-10-06T0812-10'])
})

test('list: newest first, with the count of to-dos and of high ones', async () => {
  const where = await dir()
  const store = await openDigestStore(where, capturedLog().log)
  await store.write(digest('2026-10-05T0900', [{ category: 'action' }]))
  await store.write(
    digest('2026-10-06T0900', [{ category: 'action', priority: 'high' }, { category: 'action' }, { category: 'spam' }]),
  )
  assert.deepEqual(await store.list(30), [
    { id: '2026-10-06T0900', state: 'ok', startedAt: '2026-10-06T07:00:00.000Z', todo: 2, high: 1 },
    { id: '2026-10-05T0900', state: 'ok', startedAt: '2026-10-06T07:00:00.000Z', todo: 1, high: 0 },
  ])
})

test('pruned by the date in the name, not the mtime (criterion 23)', async () => {
  const where = await dir()
  const store = await openDigestStore(where, capturedLog().log)
  for (const id of ['2026-09-01T0800', '2026-09-06T0759', '2026-09-06T0801', '2026-10-06T0800']) await store.write(digest(id))
  // Every file was just written, so every mtime is "now": only the names say which are old.
  const removed = await store.prune(30, new Date(2026, 9, 6, 8, 0))
  assert.equal(removed, 2)
  assert.deepEqual((await readdir(where)).sort(), ['2026-09-06T0801.json', '2026-10-06T0800.json'])
})

test('a broken file is skipped with a warning, never thrown', async () => {
  const where = await dir()
  const { log, lines } = capturedLog()
  await writeFile(join(where, '2026-10-06T0900.json'), '{ not json')
  await writeFile(join(where, '2026-10-05T0900.json'), JSON.stringify(digest('2026-10-05T0900')))
  await writeFile(join(where, '2026-10-04T0900.json'), JSON.stringify({ ...digest('2026-10-04T0900'), id: 'another' }))
  await writeFile(join(where, 'notes.txt'), 'ignored')
  const store = await openDigestStore(where, log)
  assert.equal((await store.latest())?.id, '2026-10-05T0900')
  assert.deepEqual((await store.list(30)).map((summary) => summary.id), ['2026-10-05T0900'])
  assert.equal(await store.get('2026-10-06T0900'), undefined)
  assert.ok(lines.some((line) => line === 'warn digest 2026-10-06T0900 is broken and was skipped'))
  assert.ok(lines.some((line) => line === 'warn digest 2026-10-04T0900 is broken and was skipped'))
})

test('an id with .. or / never reaches the disk; one that is not there is undefined', async () => {
  const where = await dir()
  const store = await openDigestStore(where, capturedLog().log)
  for (const id of ['../../etc/passwd', '2026-10-06T0900/../x', '..', '2026-10-06T0900.json', '']) {
    assert.equal(DIGEST_ID.test(id), false, id)
    assert.equal(await store.get(id), undefined)
  }
  await assert.rejects(store.write(digest('../escape')), /DIGEST_ID/)
  assert.deepEqual(await readdir(where), [])
  assert.equal(await store.get('2026-10-06T0900'), undefined)
  assert.equal(await store.latest(), undefined)
})
