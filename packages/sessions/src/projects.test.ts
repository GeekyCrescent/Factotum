import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Timers } from '@factotum/core'
import { createSiteTable } from './projects.ts'
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

async function table(live: { count: number }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'factotum-table-')))
  const notes = join(root, 'notes')
  await mkdir(notes)
  const registry = memoryRegistry({ sites: [], sharedPaths: [notes] })
  const sites = createSiteTable({
    registry,
    home: join(root, 'home'),
    factotumRoot: join(root, 'home', '.factotum'),
    installRoot: undefined,
    timers,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    liveCount: () => live.count,
    caseInsensitive: false,
  })
  await sites.load()
  return { sites, notes, root }
}

test('A SHARED FOLDER REMOVED while a session ran leaves the gate at the next look with nothing running (criterion 20)', async () => {
  const live = { count: 0 }
  const { sites } = await table(live)
  assert.equal(sites.gateShared().length, 1)
  live.count = 1
  await sites.apply({ projects: [], shared: [] }, true)
  assert.equal(sites.gateShared().length, 1, 'not under a live session')
  await sites.refreshAll()
  assert.equal(sites.gateShared().length, 1)
  live.count = 0
  await sites.refreshAll()
  assert.equal(sites.gateShared().length, 0)
})

test('a registered shared folder that goes missing keeps its place: a missing folder alone never changes the list', async () => {
  const live = { count: 0 }
  const { sites, notes, root } = await table(live)
  const { rename } = await import('node:fs/promises')
  await rename(notes, join(root, 'moved'))
  await sites.refreshAll()
  assert.equal(sites.gateShared().length, 1)
  assert.equal(sites.sharedViews()[0]?.status, 'missing')
})
