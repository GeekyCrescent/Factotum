import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  colorOf,
  createRegistryStore,
  deriveId,
  factotumRootOf,
  isValidId,
  readRegistry,
  registryFile,
  type RegistrySeed,
} from './registry.ts'
import type { RegistryStore, RegistryView } from './types.ts'

const NOW = () => new Date('2026-09-29T10:00:00.000Z')

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'factotum-registry-'))
}

const PROD_SEED: RegistrySeed = {
  sites: [
    { id: 'proyecto-a', path: '/tmp/factotum-proyecto-a' },
    { id: 'proyecto-b', path: '/tmp/factotum-proyecto-b' },
  ],
  sharedPaths: ['/Users/ferro/Ferro/Obsidian/Personal/00-inbox'],
}

async function onDisk(file: string): Promise<{ version: number; projects: unknown[]; shared: unknown[] }> {
  return JSON.parse(await readFile(file, 'utf8')) as { version: number; projects: unknown[]; shared: unknown[] }
}

const rename = (id: string, name: string) => async (current: RegistryView) => {
  const found = current.projects.find((p) => p.id === id)
  return { kind: 'set-project' as const, id, name, color: found?.color }
}

// ---------------------------------------------------------------------------
// criterion 1 — the seed, and only on ENOENT
// ---------------------------------------------------------------------------

test('WITH NO FILE, the first start seeds it from the config LITERALLY, missing folders included (criterion 1)', async () => {
  const dir = await scratch()
  const store = createRegistryStore({ file: registryFile(dir), seed: PROD_SEED, now: NOW })
  const loaded = await store.load()

  assert.equal(loaded.kind, 'ok')
  if (loaded.kind !== 'ok') return
  assert.deepEqual(loaded.registry.projects.map((p) => [p.id, p.path]), [
    ['proyecto-a', '/tmp/factotum-proyecto-a'],
    ['proyecto-b', '/tmp/factotum-proyecto-b'],
  ])
  assert.deepEqual(loaded.registry.shared.map((s) => s.path), ['/Users/ferro/Ferro/Obsidian/Personal/00-inbox'])
  assert.match(loaded.warnings.join('\n'), /seeded .*projects\.json from the config: 2 project\(s\), 1 shared/)
  // Written as it came: no realpath, no existence check.
  assert.deepEqual(await onDisk(registryFile(dir)), {
    version: 1,
    projects: [
      { id: 'proyecto-a', path: '/tmp/factotum-proyecto-a' },
      { id: 'proyecto-b', path: '/tmp/factotum-proyecto-b' },
    ],
    shared: [{ path: '/Users/ferro/Ferro/Obsidian/Personal/00-inbox' }],
  })
})

test('ANY OTHER READ ERROR IS BROKEN, never a seed: the file is not written over (criterion 1)', async () => {
  const dir = await scratch()
  const file = registryFile(dir)
  await mkdir(file) // EISDIR: it exists, and it cannot be read as a file
  const store = createRegistryStore({ file, seed: PROD_SEED, now: NOW })
  const loaded = await store.load()
  assert.equal(loaded.kind, 'broken')
  assert.match(loaded.kind === 'broken' ? loaded.reason : '', /cannot be read/)
})

test('a seed that cannot be written still runs from memory, says so, and the next change tries the disk again', async () => {
  const dir = await scratch()
  let failing = true
  const store = createRegistryStore({
    file: registryFile(dir),
    seed: PROD_SEED,
    now: NOW,
    write: async (file, text) => {
      if (failing) throw Object.assign(new Error('full'), { code: 'ENOSPC' })
      await writeFile(file, text)
    },
  })
  const loaded = await store.load()
  assert.equal(loaded.kind, 'ok')
  assert.match(loaded.kind === 'ok' ? loaded.warnings.join('\n') : '', /could not write .*ENOSPC.*from memory/)
  failing = false
  assert.equal((await store.update(rename('proyecto-a', 'A'))).kind, 'ok')
  assert.equal((await onDisk(registryFile(dir))).projects.length, 2)
})

// ---------------------------------------------------------------------------
// criterion 2 — one source
// ---------------------------------------------------------------------------

test('WITH A FILE, what is only in the config is NOT loaded, and the start says so (criterion 2)', async () => {
  const dir = await scratch()
  const file = registryFile(dir)
  await writeFile(file, JSON.stringify({ version: 1, projects: [{ id: 'proyecto-a', path: '/tmp/factotum-proyecto-a' }], shared: [] }))
  const store = createRegistryStore({ file, seed: PROD_SEED, now: NOW })
  const loaded = await store.load()
  assert.equal(loaded.kind, 'ok')
  if (loaded.kind !== 'ok') return
  assert.deepEqual(loaded.registry.projects.map((p) => p.id), ['proyecto-a'])
  assert.match(loaded.warnings.join('\n'), /site "proyecto-b" is in the config but not in .*: not loaded/)
  assert.match(loaded.warnings.join('\n'), /shared path .*00-inbox is in the config but not in/)
})

// ---------------------------------------------------------------------------
// criterion 4 — the only writer, in a queue
// ---------------------------------------------------------------------------

test('TWO CHANGES AT ONCE both end up on disk and in memory (criterion 4)', async () => {
  const dir = await scratch()
  const store = createRegistryStore({ file: registryFile(dir), seed: PROD_SEED, now: NOW })
  await store.load()

  const [renamed, added] = await Promise.all([
    store.update(rename('proyecto-a', 'Proyecto A')),
    store.update(async () => ({ kind: 'add-project', id: 'web', path: '/Users/me/web', name: undefined, color: 3 })),
  ])
  assert.equal(renamed.kind, 'ok')
  assert.equal(added.kind, 'ok')
  const final = added.kind === 'ok' ? added.registry : undefined
  assert.equal(final?.projects.find((p) => p.id === 'proyecto-a')?.name, 'Proyecto A')
  assert.deepEqual(final?.projects.find((p) => p.id === 'web'), { id: 'web', path: '/Users/me/web', color: 3, addedAt: NOW().toISOString() })

  const disk = await onDisk(registryFile(dir))
  assert.deepEqual(disk.projects, [
    { id: 'proyecto-a', path: '/tmp/factotum-proyecto-a', name: 'Proyecto A' },
    { id: 'proyecto-b', path: '/tmp/factotum-proyecto-b' },
    { id: 'web', path: '/Users/me/web', color: 3, addedAt: NOW().toISOString() },
  ])
})

test('`decide` runs INSIDE the queue: the second sees the first one’s write (criterion 15)', async () => {
  const dir = await scratch()
  const store = createRegistryStore({ file: registryFile(dir), seed: { sites: [], sharedPaths: [] }, now: NOW })
  await store.load()
  const seen: number[] = []
  const add = (id: string) =>
    store.update(async (current) => {
      seen.push(current.projects.length)
      return { kind: 'add-project', id, path: `/p/${id}` }
    })
  await Promise.all([add('a'), add('b')])
  assert.deepEqual(seen, [0, 1])
})

test('A WRITE THAT FAILS leaves memory as it was, says why, and the next write works (criterion 4)', async () => {
  const dir = await scratch()
  let fail = false
  const store = createRegistryStore({
    file: registryFile(dir),
    seed: PROD_SEED,
    now: NOW,
    write: async (file, text) => {
      if (fail) throw Object.assign(new Error('nope'), { code: 'EACCES' })
      await writeFile(file, text)
    },
  })
  await store.load()
  fail = true
  const failed = await store.update(rename('proyecto-a', 'lost'))
  assert.deepEqual(failed, { kind: 'failed', reason: `could not write ${registryFile(dir)}: EACCES` })

  fail = false
  const next = await store.update(rename('proyecto-b', 'kept'))
  assert.equal(next.kind, 'ok')
  if (next.kind !== 'ok') return
  // The failed rename never happened, in memory either.
  assert.equal(next.registry.projects.find((p) => p.id === 'proyecto-a')?.name, undefined)
  assert.equal(next.registry.projects.find((p) => p.id === 'proyecto-b')?.name, 'kept')
})

test('a `decide` that throws does not poison the queue', async () => {
  const dir = await scratch()
  const store = createRegistryStore({ file: registryFile(dir), seed: PROD_SEED, now: NOW })
  await store.load()
  await assert.rejects(() => store.update(async () => Promise.reject(new Error('boom'))), /boom/)
  assert.equal((await store.update(rename('proyecto-a', 'fine'))).kind, 'ok')
})

test('refusals: from `decide`, and from the edit itself as the last line of defence', async () => {
  const dir = await scratch()
  const store = createRegistryStore({ file: registryFile(dir), seed: PROD_SEED, now: NOW })
  await store.load()
  const cases: Array<[Parameters<RegistryStore['update']>[0], RegExp]> = [
    [async () => ({ refused: 'not today' }), /not today/],
    [async () => ({ kind: 'add-project', id: 'proyecto-a', path: '/x' }), /already taken/],
    [async () => ({ kind: 'add-project', id: 'x', path: '/tmp/factotum-proyecto-a' }), /already a project/],
    [async () => ({ kind: 'add-project', id: 'x', path: 'relative' }), /absolute/],
    [async () => ({ kind: 'set-project', id: 'nope', name: 'x' }), /no project "nope"/],
    [async () => ({ kind: 'set-project', id: 'proyecto-a', name: 'x'.repeat(41) }), /name/],
    [async () => ({ kind: 'remove-project', id: 'nope' }), /no project/],
    [async () => ({ kind: 'add-shared', path: '/Users/ferro/Ferro/Obsidian/Personal/00-inbox' }), /already shared/],
    [async () => ({ kind: 'add-shared', path: 'relative' }), /absolute/],
    [async () => ({ kind: 'remove-shared', path: '/nope' }), /not shared/],
  ]
  for (const [decide, reason] of cases) {
    const result = await store.update(decide)
    assert.equal(result.kind, 'refused')
    assert.match(result.kind === 'refused' ? result.reason : '', reason)
  }
})

test('removing a project and adding and removing a shared folder', async () => {
  const dir = await scratch()
  const store = createRegistryStore({ file: registryFile(dir), seed: PROD_SEED, now: NOW })
  await store.load()
  assert.equal((await store.update(async () => ({ kind: 'remove-project', id: 'proyecto-b' }))).kind, 'ok')
  assert.equal((await store.update(async () => ({ kind: 'add-shared', path: '/Users/me/notes' }))).kind, 'ok')
  const last = await store.update(async () => ({ kind: 'remove-shared', path: '/Users/ferro/Ferro/Obsidian/Personal/00-inbox' }))
  assert.deepEqual(last.kind === 'ok' ? last.registry.shared : [], [{ path: '/Users/me/notes', addedAt: NOW().toISOString() }])
  assert.deepEqual((await onDisk(registryFile(dir))).projects, [{ id: 'proyecto-a', path: '/tmp/factotum-proyecto-a' }])
})

// ---------------------------------------------------------------------------
// criterion 5 — nothing from outside while running
// ---------------------------------------------------------------------------

test('A HAND EDIT WHILE RUNNING is ignored and overwritten by the next write; with the daemon stopped, it loads (criterion 5)', async () => {
  const dir = await scratch()
  const file = registryFile(dir)
  const running = createRegistryStore({ file, seed: PROD_SEED, now: NOW })
  await running.load()

  const disk = await onDisk(file)
  await writeFile(file, JSON.stringify({ ...disk, projects: [...disk.projects, { id: 'sneaky', path: '/Users/me/sneaky' }] }))
  const after = await running.update(rename('proyecto-a', 'A'))
  assert.equal(after.kind === 'ok' ? after.registry.projects.some((p) => p.id === 'sneaky') : true, false)
  assert.equal((await onDisk(file)).projects.some((p) => (p as { id: string }).id === 'sneaky'), false, 'overwritten')

  // The daemon stops; the owner edits; the next start loads it.
  const edited = await onDisk(file)
  await writeFile(file, JSON.stringify({ ...edited, projects: [...edited.projects, { id: 'by-hand', path: '/Users/me/by-hand' }] }))
  const restarted = createRegistryStore({ file, seed: PROD_SEED, now: NOW })
  const loaded = await restarted.load()
  assert.equal(loaded.kind === 'ok' && loaded.registry.projects.some((p) => p.id === 'by-hand'), true)
})

// ---------------------------------------------------------------------------
// criterion 6 — a broken file, and bad entries
// ---------------------------------------------------------------------------

test('A FILE THAT DOES NOT PARSE, or has no version or lists, is BROKEN: nothing loads and nothing is written (criterion 6)', async () => {
  for (const [text, reason] of [
    ['{ not json', /not valid JSON/],
    [JSON.stringify({ projects: [], shared: [] }), /version/],
    [JSON.stringify({ version: 1, projects: [] }), /shared/],
    [JSON.stringify({ version: 2, projects: [], shared: [] }), /version/],
  ] as const) {
    const dir = await scratch()
    const file = registryFile(dir)
    await writeFile(file, text)
    const store = createRegistryStore({ file, seed: PROD_SEED, now: NOW })
    const loaded = await store.load()
    assert.equal(loaded.kind, 'broken', text)
    assert.match(loaded.kind === 'broken' ? loaded.reason : '', reason)
    const update = await store.update(rename('proyecto-a', 'x'))
    assert.equal(update.kind, 'broken')
    assert.equal(await readFile(file, 'utf8'), text, 'never written over')
  }
})

test('A BAD ENTRY is skipped with a warning and the others load; addedAt is optional (criterion 6)', async () => {
  const dir = await scratch()
  const file = registryFile(dir)
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      projects: [
        { id: 'good', path: '/Users/me/good' },
        { path: '/Users/me/no-id' },
        { id: 'rel', path: 'relative/path' },
        { id: 'good', path: '/Users/me/again' },
        { id: 'dup-path', path: '/Users/me/good' },
        { id: 'hue', path: '/Users/me/hue', color: 9 },
        { id: 'fine', path: '/Users/me/fine', name: 'Fine', color: 4, addedAt: '2026-09-01T00:00:00.000Z' },
      ],
      shared: [{ path: '/Users/me/notes' }, { path: 'nope' }, { path: '/Users/me/notes' }],
    }),
  )
  const store = createRegistryStore({ file, seed: { sites: [], sharedPaths: [] }, now: NOW })
  const loaded = await store.load()
  assert.equal(loaded.kind, 'ok')
  if (loaded.kind !== 'ok') return
  assert.deepEqual(loaded.registry.projects.map((p) => p.id), ['good', 'fine'])
  assert.deepEqual(loaded.registry.shared.map((s) => s.path), ['/Users/me/notes'])
  assert.deepEqual(
    loaded.skipped.map((s) => [s.list, s.index]),
    [
      ['projects', 1],
      ['projects', 2],
      ['projects', 3],
      ['projects', 4],
      ['projects', 5],
      ['shared', 1],
      ['shared', 2],
    ],
  )
  assert.match(loaded.skipped[2]?.reason ?? '', /already taken/)
  assert.match(loaded.skipped[3]?.reason ?? '', /already a project/)
  assert.equal(loaded.warnings.length, 7)
})

test('THE SKIPPED ENTRIES ARE WRITTEN BACK AS THEY WERE: a rename never deletes what the owner typed', async () => {
  const dir = await scratch()
  const file = registryFile(dir)
  const typo = { id: 'Bad Id', path: '/Users/me/typo', note: 'mine' }
  await writeFile(file, JSON.stringify({ version: 1, projects: [{ id: 'good', path: '/Users/me/good' }, typo], shared: [{ path: 'rel' }] }))
  const store = createRegistryStore({ file, seed: { sites: [], sharedPaths: [] }, now: NOW })
  await store.load()
  await store.update(rename('good', 'Good'))
  const disk = await onDisk(file)
  assert.deepEqual(disk.projects, [{ id: 'good', path: '/Users/me/good', name: 'Good' }, typo])
  assert.deepEqual(disk.shared, [{ path: 'rel' }])
})

test('readRegistry says missing, ok or broken, for the CLI', async () => {
  const dir = await scratch()
  assert.equal((await readRegistry(join(dir, 'none.json'))).kind, 'missing')
  await writeFile(join(dir, 'ok.json'), JSON.stringify({ version: 1, projects: [], shared: [] }))
  assert.equal((await readRegistry(join(dir, 'ok.json'))).kind, 'ok')
})

// ---------------------------------------------------------------------------
// the id rule, the root, the colour
// ---------------------------------------------------------------------------

test('the id comes from a folder name, or not at all', () => {
  assert.equal(deriveId('My Project'), 'my-project')
  assert.equal(deriveId('factotum-proyecto-a'), 'factotum-proyecto-a')
  assert.equal(deriveId('__Web__'), 'web')
  assert.equal(deriveId('ñ'), undefined)
  assert.equal(deriveId('...'), undefined)
  assert.equal(isValidId('web-2'), true)
  assert.equal(isValidId('-web'), false)
  assert.equal(isValidId('Web'), false)
})

test('factotumRootOf climbs from the module state dir to ~/.factotum', () => {
  assert.equal(factotumRootOf('/Users/me/.factotum/prod/modules/sessions'), '/Users/me/.factotum')
})

test('colorOf accepts the six tones and nothing else', () => {
  assert.equal(colorOf(1), 1)
  assert.equal(colorOf(6), 6)
  assert.equal(colorOf(0), undefined)
  assert.equal(colorOf('2'), undefined)
})
