import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServiceRegistry, type RegistryEntry } from './registry.ts'

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'factotum-registry-'))
}

const entry = (n: number, sessionId = 'sess-a'): RegistryEntry => ({ sessionId, id: `s${n}`, pid: 1000 + n, startedAt: `t${n}` })

test('a registry that does not exist reads as empty, and nothing is created by reading it', async () => {
  const root = await scratch()
  const file = join(root, 'services.json')
  const registry = createServiceRegistry(file, 4242)
  assert.deepEqual(await registry.read(), { kind: 'empty' })
  assert.deepEqual(await readdir(root), [])
  await rm(root, { recursive: true })
})

test('add and remove write the whole file atomically, stamped with this daemon pid', async () => {
  const root = await scratch()
  const file = join(root, 'services.json')
  const registry = createServiceRegistry(file, 4242)
  await registry.add(entry(1))
  await registry.add(entry(2, 'sess-b'))
  await registry.remove('sess-a', 's1')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { daemonPid: 4242, services: [entry(2, 'sess-b')] })
  assert.deepEqual(await registry.read(), { kind: 'ok', daemonPid: 4242, services: [entry(2, 'sess-b')] })
  // No temp file left behind.
  assert.deepEqual(await readdir(root), ['services.json'])
  await rm(root, { recursive: true })
})

test('remove only takes the entry of THAT session: the same id in another session stays', async () => {
  const root = await scratch()
  const registry = createServiceRegistry(join(root, 'services.json'), 1)
  await registry.add(entry(1, 'sess-a'))
  await registry.add(entry(1, 'sess-b'))
  await registry.remove('sess-a', 's1')
  const read = await registry.read()
  assert.equal(read.kind, 'ok')
  assert.deepEqual(read.kind === 'ok' ? read.services : [], [entry(1, 'sess-b')])
  await rm(root, { recursive: true })
})

test('TEN CONCURRENT adds leave ten entries: the writes are chained (D6)', async () => {
  const root = await scratch()
  const registry = createServiceRegistry(join(root, 'services.json'), 1)
  await Promise.all(Array.from({ length: 10 }, (_, i) => registry.add(entry(i))))
  const read = await registry.read()
  assert.equal(read.kind === 'ok' ? read.services.length : -1, 10)
  await rm(root, { recursive: true })
})

test('clear leaves an empty list', async () => {
  const root = await scratch()
  const registry = createServiceRegistry(join(root, 'services.json'), 7)
  await registry.add(entry(1))
  await registry.clear()
  assert.deepEqual(await registry.read(), { kind: 'ok', daemonPid: 7, services: [] })
  await rm(root, { recursive: true })
})

test('a corrupt file reads as corrupt, and quarantine moves it to .bad to keep the evidence', async () => {
  const root = await scratch()
  const file = join(root, 'services.json')
  for (const bad of ['{not json', '[]', '{"daemonPid":"x","services":[]}', '{"daemonPid":1,"services":[{"id":3}]}']) {
    await writeFile(file, bad)
    const registry = createServiceRegistry(file, 1)
    assert.deepEqual(await registry.read(), { kind: 'corrupt' }, bad)
    await registry.quarantine()
    assert.equal(await readFile(`${file}.bad`, 'utf8'), bad)
    assert.deepEqual(await registry.read(), { kind: 'empty' })
  }
  await rm(root, { recursive: true })
})

test('a failed write rejects for the caller and does not poison the chain for the next one', async () => {
  const root = await scratch()
  const registry = createServiceRegistry(join(root, 'missing-dir', 'services.json'), 1)
  await assert.rejects(registry.add(entry(1)))
  await rm(root, { recursive: true })
  // The directory is gone for good; the next call still runs (and fails on its own).
  await assert.rejects(registry.add(entry(2)))
})

test('a registry that exists but cannot be READ is an error, never "corrupt": it is not moved aside', async () => {
  const root = await scratch()
  const file = join(root, 'services.json')
  // A directory where the file should be: readFile fails with EISDIR, which is not a bad format.
  await mkdir(file)
  const registry = createServiceRegistry(file, 1)
  await assert.rejects(registry.read())
  await rm(root, { recursive: true })
})
