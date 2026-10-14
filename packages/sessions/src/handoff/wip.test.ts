import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { carry, commitAll, indexPath, put, sh, world } from '../test-repos.ts'
import { wipCommit, wipTree } from './wip.ts'

const HID = '0199e0c0-0000-7000-8000-000000000001'

// ---------------------------------------------------------------------------
// G2 — wipTree(seed) and wipCommit (design D10)
// ---------------------------------------------------------------------------

test('wipCommit leaves the owner’s index and HEAD exactly as they were', async () => {
  const w = await world()
  await put(w.source, 'a.txt', 'changed\n')
  await put(w.source, 'staged.txt', 'staged\n')
  await sh(w.env, w.source, 'add', 'staged.txt')
  await put(w.source, 'new.txt', 'new\n')
  const headBefore = await sh(w.env, w.source, 'rev-parse', 'HEAD')
  const statusBefore = await sh(w.env, w.source, 'status', '--porcelain')
  const indexBefore = await readFile(join(w.source, '.git', 'index'))

  const made = await wipCommit(w.source, { indexFile: await indexPath(w), hid: HID, host: 'mac', base: w.env })

  assert.notEqual(made.wip, undefined)
  assert.equal(made.head, headBefore)
  assert.equal(await sh(w.env, w.source, 'rev-parse', 'HEAD'), headBefore)
  assert.equal(await sh(w.env, w.source, 'status', '--porcelain'), statusBefore)
  assert.deepEqual(await readFile(join(w.source, '.git', 'index')), indexBefore)
  // The WIP is the working tree: the change, the staged file and the new one.
  const files = (await sh(w.env, w.source, 'ls-tree', '-r', '--name-only', made.wip ?? '')).split('\n')
  assert.deepEqual(files.sort(), ['a.txt', 'new.txt', 'staged.txt'])
  assert.equal(await sh(w.env, w.source, 'rev-parse', `${made.wip}^`), headBefore)
  assert.equal(await sh(w.env, w.source, 'rev-parse', `${made.wip}^{tree}`), made.tree)
})

test('what git ignores never enters the WIP: a .env.local is not in ls-tree (criterion 27)', async () => {
  const w = await world()
  await put(w.source, '.gitignore', '.env.local\n')
  await commitAll(w.env, w.source)
  await put(w.source, '.env.local', 'SECRET=1\n')
  await put(w.source, 'b.txt', 'b\n')
  const made = await wipCommit(w.source, { indexFile: await indexPath(w), hid: HID, host: 'mac', base: w.env })
  const files = await sh(w.env, w.source, 'ls-tree', '-r', '--name-only', made.wip ?? '')
  assert.doesNotMatch(files, /\.env\.local/)
  assert.match(files, /b\.txt/)
})

test('a clean tree makes no WIP', async () => {
  const w = await world()
  const made = await wipCommit(w.source, { indexFile: await indexPath(w), hid: HID, host: 'mac', base: w.env })
  assert.equal(made.wip, undefined)
  assert.equal(made.tree, await sh(w.env, w.source, 'rev-parse', 'HEAD^{tree}'))
})

test('with commit.gpgSign=true and no user.email anywhere, the WIP is made all the same, as factotum', async () => {
  const w = await world()
  await sh(w.env, w.source, 'config', 'commit.gpgSign', 'true')
  await sh(w.env, w.source, 'config', 'gpg.program', '/nonexistent/gpg')
  await put(w.source, 'b.txt', 'b\n')
  // No identity in the environment: `sh` adds one, `wipCommit` must not need it.
  const made = await wipCommit(w.source, { indexFile: await indexPath(w), hid: HID, host: 'mac', base: w.env })
  assert.notEqual(made.wip, undefined)
  assert.equal(await sh(w.env, w.source, 'log', '-1', '--format=%an <%ae>|%s', made.wip ?? ''), `factotum <factotum@mac.invalid>|factotum handoff ${HID} from mac`)
})

test('the seed: on a host that ignores a file of the WIP, seed = HEAD gives another tree and seed = <wip> gives the WIP’s', async () => {
  const w = await world()
  await put(w.source, 'secret.local', 'S\n')
  await put(w.source, 'a.txt', 'changed\n')
  const made = await wipCommit(w.source, { indexFile: await indexPath(w), hid: HID, host: 'mac', base: w.env })
  const wip = made.wip ?? ''
  await carry(w, w.source, w.target, wip)
  // The target ignores it, outside the repo, and has exactly the WIP's working tree.
  await writeFile(join(w.target, '.git', 'info', 'exclude'), 'secret.local\n')
  await sh(w.env, w.target, 'read-tree', '-m', '-u', 'HEAD', wip)
  await sh(w.env, w.target, 'reset', '-q')

  const fromHead = await wipTree(w.target, { indexFile: await indexPath(w), base: w.env })
  const fromWip = await wipTree(w.target, { indexFile: await indexPath(w), seed: wip, base: w.env })
  assert.notEqual(fromHead, made.tree)
  assert.equal(fromWip, made.tree)
})

test('the temporary index does not outlive the call', async () => {
  const w = await world()
  const index = await indexPath(w)
  await put(w.source, 'b.txt', 'b\n')
  await wipTree(w.source, { indexFile: index, base: w.env })
  await assert.rejects(readFile(index))
  await rm(index, { force: true })
})
