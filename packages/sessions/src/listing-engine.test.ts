/**
 * `files` through the real engine (spec 2026-10-01-referencias-y-tab, block B6): an unknown project, a
 * missing one, the root of one that is there with the shared folders beside it, and the setup view.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Timers } from '@factotum/core'
import { createEngine } from './engine.ts'
import { MAX_ENTRIES } from './listing.ts'
import { memoryRegistry } from './test-registry.ts'

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

async function world() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'factotum-files-engine-')))
  const stateDir = join(home, 'state')
  const siteDir = join(home, 'site')
  const sharedDir = join(home, 'notes')
  await mkdir(stateDir, { recursive: true })
  await mkdir(join(siteDir, 'src'), { recursive: true })
  await writeFile(join(siteDir, 'README.md'), '')
  await mkdir(sharedDir)
  const engine = await createEngine(
    {
      titles: { enabled: false, model: 'haiku', effort: 'low' },
      uploadMaxBytes: 1024,
      stateDir,
      registry: memoryRegistry({ sites: [{ id: 'work', path: siteDir }], sharedPaths: [sharedDir] }),
      home: '/nonexistent-home-for-tests',
      factotumRoot: '/nonexistent-home-for-tests/.factotum',
      installRoot: undefined,
      catalog: [{ id: 'free', label: 'Free prompt', invoke: { kind: 'none' } }],
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => new Date(),
      timers,
      hookUrl: () => 'http://127.0.0.1:7778',
      notify: { canReach: () => false, send: async () => undefined },
    },
    { caseInsensitive: false },
  )
  await engine.reconcile()
  return { engine, siteDir, sharedDir }
}

test('an unknown project is unknown', async () => {
  const { engine } = await world()
  assert.deepEqual(await engine.files({ siteId: 'nope', dir: undefined, prefix: '' }), { outcome: 'unknown' })
  await engine.stop()
})

test('a project whose folder is missing lists nothing (criterion 13)', async () => {
  const { engine, siteDir } = await world()
  await rm(siteDir, { recursive: true })
  assert.deepEqual(await engine.files({ siteId: 'work', dir: undefined, prefix: '' }), { outcome: 'missing', siteId: 'work' })
  await engine.stop()
})

test('the root of a project lists, with the shared folder beside it (criteria 5, 12)', async () => {
  const { engine, siteDir, sharedDir } = await world()
  const result = await engine.files({ siteId: 'work', dir: undefined, prefix: '' })
  assert.equal(result.outcome, 'ok')
  if (result.outcome !== 'ok') return
  assert.deepEqual(result.listing.entries, [
    { name: 'src', kind: 'dir' },
    { name: 'README.md', kind: 'file' },
  ])
  assert.equal(result.listing.dir, siteDir)
  assert.deepEqual(result.listing.shared, [{ path: sharedDir, name: 'notes' }])
  await engine.stop()
})

test('a shared folder that went missing is neither shown nor listed (criterion 12)', async () => {
  const { engine, sharedDir } = await world()
  await rm(sharedDir, { recursive: true })
  await engine.projects() // looks at every folder again, as the projects screen does
  const root = await engine.files({ siteId: 'work', dir: undefined, prefix: '' })
  assert.equal(root.outcome === 'ok' && root.listing.shared.length, 0)
  assert.deepEqual(await engine.files({ siteId: 'work', dir: sharedDir, prefix: '' }), { outcome: 'outside' })
  await engine.stop()
})

test('the setup view says this host lists files, and up to how many (criterion 17)', async () => {
  const { engine } = await world()
  assert.deepEqual(engine.view().files, { maxEntries: MAX_ENTRIES })
  await engine.stop()
})
