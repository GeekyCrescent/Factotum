import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { opendir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Timers } from '@factotum/core'
import { createLister, isHidden, MAX_ENTRIES, type ListingDisk } from './listing.ts'
import type { Site } from './sites.ts'
import type { FilesResult, Listing } from './types.ts'

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

/** A project with the shapes the spec measured on the real disk (requirements §0.4). */
async function world() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'factotum-listing-')))
  const root = join(base, 'site')
  await mkdir(join(root, 'src', 'components'), { recursive: true })
  await mkdir(join(root, 'docs', 'sub'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'x'), { recursive: true })
  await mkdir(join(root, '.git'))
  await mkdir(join(root, '.claude', 'skills'), { recursive: true })
  await mkdir(join(root, '.agents', 'skills', 'neon'), { recursive: true })
  await writeFile(join(root, 'src', 'app.ts'), '')
  await writeFile(join(root, 'src', 'Config.ts'), '')
  await writeFile(join(root, 'docs', 'mi nota.md'), '')
  await writeFile(join(root, 'README.md'), '')
  await writeFile(join(root, '.env'), '')
  await writeFile(join(root, '.DS_Store'), '')
  // Inside: `maqueta/.claude/skills/neon -> ../../.agents/skills/neon`, the real case.
  await symlink('../../.agents/skills/neon', join(root, '.claude', 'skills', 'neon'))
  const outside = join(base, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), '')
  await symlink(outside, join(root, 'escape'))
  await symlink(join(root, 'nowhere'), join(root, 'broken'))
  await symlink(join(root, 'node_modules', 'x'), join(root, 'sneaky'))
  const sibling = join(base, 'siteb')
  await mkdir(sibling)
  const sharedPath = join(base, 'shared')
  await mkdir(join(sharedPath, 'notes'), { recursive: true })
  await writeFile(join(sharedPath, 'notes', 'c.md'), '')
  const site: Site = { id: 'demo', path: root, realPath: root, isRepo: false }
  const shared: Site = { id: 'shared', path: sharedPath, realPath: sharedPath, isRepo: false }
  return { base, root, outside, sibling, sharedPath, site, shared }
}

function ok(result: FilesResult): Listing {
  assert.equal(result.outcome, 'ok', JSON.stringify(result))
  return (result as { listing: Listing }).listing
}

const names = (listing: Listing) => listing.entries.map((entry) => `${entry.kind}:${entry.name}`)

// ---------------------------------------------------------------------------
// D1 — what is hidden
// ---------------------------------------------------------------------------

test('the always-hidden names are hidden in any case', () => {
  for (const name of ['.git', 'node_modules', '.next', 'dist', '.DS_Store', 'NODE_MODULES', '.GIT', 'Dist']) {
    assert.equal(isHidden(name), true, name)
  }
  assert.equal(isHidden('.github'), false)
  assert.equal(isHidden('distribution'), false)
})

// ---------------------------------------------------------------------------
// D2, D3 — listing (criteria 5, 6, 8, 9, 10, 11, 12)
// ---------------------------------------------------------------------------

test('the root lists folders first, then files, with name and kind only (criterion 5)', async () => {
  const w = await world()
  const listing = ok(await createLister({ timers }).list({ site: w.site, shared: [], dir: undefined, prefix: '' }))
  assert.deepEqual(names(listing), ['dir:docs', 'dir:src', 'file:README.md'])
  assert.deepEqual(Object.keys(listing.entries[0] ?? {}).sort(), ['kind', 'name'])
  assert.deepEqual(listing.root, { kind: 'site', path: w.root })
  assert.equal(listing.dir, w.root)
  assert.equal(listing.more, 0)
  assert.equal(listing.partial, false)
})

test('a folder below the root is listed (criterion 6)', async () => {
  const w = await world()
  const listing = ok(await createLister({ timers }).list({ site: w.site, shared: [], dir: join(w.root, 'src'), prefix: '' }))
  assert.deepEqual(names(listing), ['dir:components', 'file:app.ts', 'file:Config.ts'])
  assert.equal(listing.dir, join(w.root, 'src'))
})

test('hidden names never show and dotfiles show only for a dot prefix (criterion 9)', async () => {
  const w = await world()
  const lister = createLister({ timers })
  const dotted = ok(await lister.list({ site: w.site, shared: [], dir: undefined, prefix: '.' }))
  assert.deepEqual(names(dotted), ['dir:.agents', 'dir:.claude', 'file:.env'])
  const plain = ok(await lister.list({ site: w.site, shared: [], dir: undefined, prefix: '' }))
  assert.equal(plain.entries.some((entry) => entry.name.startsWith('.')), false)
  const nm = ok(await lister.list({ site: w.site, shared: [], dir: undefined, prefix: 'node' }))
  assert.deepEqual(nm.entries, [])
})

test('a link inside its root shows as its target and can be entered; one that leaves, breaks or hides does not (criterion 8)', async () => {
  const w = await world()
  const lister = createLister({ timers })
  const skills = ok(await lister.list({ site: w.site, shared: [], dir: join(w.root, '.claude', 'skills'), prefix: '' }))
  assert.deepEqual(names(skills), ['dir:neon'])
  ok(await lister.list({ site: w.site, shared: [], dir: join(w.root, '.claude', 'skills', 'neon'), prefix: '' }))
  const top = ok(await lister.list({ site: w.site, shared: [], dir: undefined, prefix: '' }))
  for (const gone of ['escape', 'broken', 'sneaky']) assert.equal(top.entries.some((entry) => entry.name === gone), false, gone)
})

test('the prefix filters ignoring case and comparing in NFC (criterion 10)', async () => {
  const w = await world()
  const nfd = 'canción.md'
  await writeFile(join(w.root, nfd), '')
  const lister = createLister({ timers })
  const found = ok(await lister.list({ site: w.site, shared: [], dir: undefined, prefix: 'CANCIÓ' }))
  assert.deepEqual(names(found), [`file:${nfd}`])
  const co = ok(await lister.list({ site: w.site, shared: [], dir: join(w.root, 'src'), prefix: 'co' }))
  assert.deepEqual(names(co), ['dir:components', 'file:Config.ts'])
})

test('the ceiling cuts after the filter and counts what did not fit (criterion 11)', async () => {
  const w = await world()
  const many = join(w.root, 'many')
  await mkdir(many)
  for (let i = 0; i < 500; i += 1) await writeFile(join(many, `f${String(i).padStart(3, '0')}.txt`), '')
  for (let i = 0; i < 20; i += 1) await writeFile(join(many, `z${i}.txt`), '')
  const lister = createLister({ timers })
  const all = ok(await lister.list({ site: w.site, shared: [], dir: many, prefix: '' }))
  assert.equal(all.entries.length, MAX_ENTRIES)
  assert.equal(all.more, 520 - MAX_ENTRIES)
  const z = ok(await lister.list({ site: w.site, shared: [], dir: many, prefix: 'z' }))
  assert.equal(z.entries.length, 20)
  assert.equal(z.more, 0)
})

test('shared folders outside the project show at its root, and can be listed from any project (criterion 12)', async () => {
  const w = await world()
  const inside: Site = { id: 'shared', path: join(w.root, 'docs'), realPath: join(w.root, 'docs'), isRepo: false }
  const same: Site = { id: 'shared', path: w.root, realPath: w.root, isRepo: false }
  const lister = createLister({ timers })
  const top = ok(await lister.list({ site: w.site, shared: [w.shared, inside, same], dir: undefined, prefix: '' }))
  assert.deepEqual(top.shared, [{ path: w.sharedPath, name: 'shared' }])
  const below = ok(await lister.list({ site: w.site, shared: [w.shared], dir: join(w.root, 'src'), prefix: '' }))
  assert.deepEqual(below.shared, [])
  const filtered = ok(await lister.list({ site: w.site, shared: [w.shared], dir: undefined, prefix: 'x' }))
  assert.deepEqual(filtered.shared, [])
  const inShared = ok(await lister.list({ site: w.site, shared: [w.shared], dir: join(w.sharedPath, 'notes'), prefix: '' }))
  assert.deepEqual(inShared.root, { kind: 'shared', path: w.sharedPath })
  assert.deepEqual(names(inShared), ['file:c.md'])
})

test('the site wins over a shared folder that contains it (D2)', async () => {
  const w = await world()
  const above: Site = { id: 'shared', path: w.base, realPath: w.base, isRepo: false }
  const listing = ok(await createLister({ timers }).list({ site: w.site, shared: [above], dir: join(w.root, 'src'), prefix: '' }))
  assert.equal(listing.root.kind, 'site')
})

test('a root declared through a symlink answers in its declared spelling (D2)', async () => {
  const w = await world()
  const alias = join(w.base, 'alias')
  await symlink(w.root, alias)
  const site: Site = { id: 'demo', path: alias, realPath: w.root, isRepo: false }
  const lister = createLister({ timers })
  const top = ok(await lister.list({ site, shared: [], dir: undefined, prefix: '' }))
  assert.equal(top.dir, alias)
  const viaReal = ok(await lister.list({ site, shared: [], dir: join(w.root, 'src'), prefix: '' }))
  assert.equal(viaReal.dir, join(alias, 'src'))
})

// ---------------------------------------------------------------------------
// D2 — the boundary (criterion 7)
// ---------------------------------------------------------------------------

test('anything outside the boundary, hidden, absent or not a folder is one 404 and no names (criterion 7)', async () => {
  const w = await world()
  const lister = createLister({ timers })
  const refused = [
    '/etc',
    w.outside,
    w.sibling,
    join(w.root, 'escape'),
    join(w.root, 'node_modules', 'x'),
    join(w.root, 'NODE_MODULES', 'x'),
    join(w.root, '.git'),
    join(w.root, '.GIT'),
    join(w.root, 'sneaky'),
    join(w.root, 'README.md'),
    join(w.root, 'nope'),
  ]
  for (const dir of refused) {
    const result = await lister.list({ site: w.site, shared: [w.shared], dir, prefix: '' })
    assert.deepEqual(result, { outcome: 'outside' }, dir)
  }
})

test('a folder that cannot be read, or loops, is unreadable and never a throw (criteria 7, 15)', async () => {
  const w = await world()
  const locked = join(w.root, 'locked')
  await mkdir(locked)
  await chmod(locked, 0o000)
  const loop = join(w.root, 'loop')
  await symlink(loop, loop)
  const lister = createLister({ timers })
  try {
    const result = await lister.list({ site: w.site, shared: [], dir: locked, prefix: '' })
    // Running as root reads anything: then it lists, and that is not what this checks.
    if (process.getuid?.() !== 0) assert.equal(result.outcome, 'unreadable')
    const looped = await lister.list({ site: w.site, shared: [], dir: loop, prefix: '' })
    assert.equal(looped.outcome, 'unreadable')
  } finally {
    await chmod(locked, 0o755)
  }
})

// ---------------------------------------------------------------------------
// D4 — the ceiling and one read per folder (criterion 14a)
// ---------------------------------------------------------------------------

function hangingDisk(): { disk: ListingDisk; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    disk: {
      realpath: () => {
        calls += 1
        return new Promise<string>(() => {})
      },
      opendir: async (path) => await opendir(path),
      stat: async (path) => await stat(path),
    },
  }
}

test('a read that hangs times out, and a second request for the same folder does not start another (criterion 14)', async () => {
  const w = await world()
  const { disk, calls } = hangingDisk()
  const lister = createLister({ timers, disk, timeoutMs: 20 })
  const dir = join(w.root, 'src')
  const [a, b] = await Promise.all([
    lister.list({ site: w.site, shared: [], dir, prefix: '' }),
    lister.list({ site: w.site, shared: [], dir, prefix: 'a' }),
  ])
  assert.deepEqual(a, { outcome: 'timeout' })
  assert.deepEqual(b, { outcome: 'timeout' })
  const c = await lister.list({ site: w.site, shared: [], dir, prefix: '' })
  assert.deepEqual(c, { outcome: 'timeout' })
  assert.equal(calls(), 1)
})

test('two listers never share their reads (D4)', async () => {
  const w = await world()
  const first = hangingDisk()
  const second = hangingDisk()
  const dir = join(w.root, 'src')
  await createLister({ timers, disk: first.disk, timeoutMs: 10 }).list({ site: w.site, shared: [], dir, prefix: '' })
  await createLister({ timers, disk: second.disk, timeoutMs: 10 }).list({ site: w.site, shared: [], dir, prefix: '' })
  assert.equal(first.calls(), 1)
  assert.equal(second.calls(), 1)
})

test('a very large folder stops at the scan guard and says so (D4)', async () => {
  const w = await world()
  const big = join(w.root, 'big')
  await mkdir(big)
  for (let i = 0; i < 30; i += 1) await writeFile(join(big, `f${i}`), '')
  const listing = ok(await createLister({ timers, maxScan: 10 }).list({ site: w.site, shared: [], dir: big, prefix: '' }))
  assert.equal(listing.partial, true)
  assert.equal(listing.entries.length, 10)
})
