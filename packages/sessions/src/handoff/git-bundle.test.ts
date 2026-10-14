import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { carry, commitAll, indexPath, put, sh, world, type World } from './test-repos.ts'
import { wipCommit } from './wip.ts'
import { ensureBase, handoffBase, importBundle, makeBundle } from './git-bundle.ts'

const HID = '0199e0c0-0000-7000-8000-000000000002'

const exists = (path: string) => access(path).then(() => true, () => false)

async function bundlePath(w: World): Promise<string> {
  return join(await mkdtemp(join(w.home, 'state-')), 'code.bundle')
}

async function heads(w: World, bundle: string): Promise<string[]> {
  return (await sh(w.env, w.target, 'bundle', 'list-heads', bundle)).split('\n').map((line) => line.split(' ')[1] ?? '').sort()
}

async function refsUnder(w: World, repo: string, prefix: string): Promise<string> {
  return await sh(w.env, repo, 'for-each-ref', prefix)
}

/** A local commit and a WIP on the source, as the owner leaves them before going. */
async function workOnSource(w: World, opts: { readonly commit?: boolean; readonly wip?: boolean } = {}) {
  if (opts.commit !== false) {
    await put(w.source, 'local.txt', 'not pushed\n')
    await commitAll(w.env, w.source, 'local')
  }
  if (opts.wip !== false) await put(w.source, 'wip.txt', 'half done\n')
  return await wipCommit(w.source, { indexFile: await indexPath(w), hid: HID, host: 'mac', base: w.env })
}

// ---------------------------------------------------------------------------
// G3 — handoffBase and makeBundle, on the source
// ---------------------------------------------------------------------------

test('a local commit and a WIP: the bundle carries both, and its bases are on the remote', async () => {
  const w = await world()
  const made = await workOnSource(w)
  const out = await bundlePath(w)
  const bundle = await makeBundle(w.source, { hid: HID, head: made.head, wip: made.wip, base: handoffBase(undefined), out, env: w.env })
  assert.equal(bundle, out)
  assert.deepEqual(await heads(w, out), [`refs/factotum/handoff/${HID}/head`, `refs/factotum/handoff/${HID}/wip`])
  // The target has only what the remote has, and that is enough.
  assert.equal(await ensureBase(w.target, { bundle: out }, w.env), 'present')
})

test('with branchHead, the bundle’s bases are commits the target has (and the remote does not)', async () => {
  const w = await world()
  await put(w.source, 'shared.txt', 'both hosts have it\n')
  const shared = await commitAll(w.env, w.source, 'shared, never pushed')
  await carry(w, w.source, w.target, shared)
  await put(w.source, 'more.txt', 'more\n')
  await commitAll(w.env, w.source, 'more')
  const made = await wipCommit(w.source, { indexFile: await indexPath(w), hid: HID, host: 'mac', base: w.env })
  const out = await bundlePath(w)
  await makeBundle(w.source, { hid: HID, head: made.head, wip: made.wip, base: handoffBase(shared), out, env: w.env })
  const verify = await sh(w.env, w.target, 'bundle', 'verify', out).catch((error: Error) => error.message)
  assert.match(verify, new RegExp(shared))
  assert.equal(await ensureBase(w.target, { bundle: out }, w.env), 'present')
})

test('no local commit and no WIP: no bundle, and `bundle create` never runs', async () => {
  const w = await world()
  const made = await workOnSource(w, { commit: false, wip: false })
  const out = await bundlePath(w)
  assert.equal(await makeBundle(w.source, { hid: HID, head: made.head, wip: made.wip, base: handoffBase(undefined), out, env: w.env }), undefined)
  assert.equal(await exists(out), false)
})

test('a WIP and no local commit: the bundle carries the wip ref only', async () => {
  const w = await world()
  const made = await workOnSource(w, { commit: false })
  const out = await bundlePath(w)
  await makeBundle(w.source, { hid: HID, head: made.head, wip: made.wip, base: handoffBase(undefined), out, env: w.env })
  assert.deepEqual(await heads(w, out), [`refs/factotum/handoff/${HID}/wip`])
})

test('the temporary refs do not stay on the source, also when `bundle create` fails', async () => {
  const w = await world()
  const made = await workOnSource(w)
  await makeBundle(w.source, { hid: HID, head: made.head, wip: made.wip, base: handoffBase(undefined), out: await bundlePath(w), env: w.env })
  assert.equal(await refsUnder(w, w.source, 'refs/factotum/'), '')
  const nowhere = join(w.home, 'no', 'such', 'dir', 'code.bundle')
  await assert.rejects(makeBundle(w.source, { hid: HID, head: made.head, wip: made.wip, base: handoffBase(undefined), out: nowhere, env: w.env }))
  assert.equal(await refsUnder(w, w.source, 'refs/factotum/'), '')
})

// ---------------------------------------------------------------------------
// G4 — ensureBase and importBundle, on the target
// ---------------------------------------------------------------------------

test('a bundle whose bases the target has verifies without a fetch', async () => {
  const w = await world()
  const made = await workOnSource(w)
  const out = await bundlePath(w)
  await makeBundle(w.source, { hid: HID, head: made.head, wip: made.wip, base: handoffBase(undefined), out, env: w.env })
  assert.equal(await ensureBase(w.target, { bundle: out }, w.env), 'present')
})

test('a bundle missing a base the remote has: one fetch origin, and it passes', async () => {
  const w = await world()
  // The source pushed a commit and builds on it; the target never fetched it.
  await put(w.source, 'pushed.txt', 'pushed\n')
  await commitAll(w.env, w.source, 'pushed')
  await sh(w.env, w.source, 'push', '--quiet')
  const made = await workOnSource(w)
  const out = await bundlePath(w)
  await makeBundle(w.source, { hid: HID, head: made.head, wip: made.wip, base: handoffBase(undefined), out, env: w.env })
  assert.equal(await ensureBase(w.target, { bundle: out }, w.env), 'fetched')
})

test('a bundle missing a base that is nowhere: bundle-base-missing, and neither the tree nor HEAD moved (criterion 27b)', async () => {
  const w = await world()
  await put(w.source, 'private.txt', 'never pushed, never carried\n')
  const lost = await commitAll(w.env, w.source, 'private')
  const made = await workOnSource(w)
  const out = await bundlePath(w)
  // As if the target had `lost` on its branch: the bundle leaves it out, and the target lacks it.
  await makeBundle(w.source, { hid: HID, head: made.head, wip: made.wip, base: handoffBase(lost), out, env: w.env })
  const before = { head: await sh(w.env, w.target, 'rev-parse', 'HEAD'), status: await sh(w.env, w.target, 'status', '--porcelain') }
  assert.equal(await ensureBase(w.target, { bundle: out }, w.env), 'missing')
  assert.deepEqual({ head: await sh(w.env, w.target, 'rev-parse', 'HEAD'), status: await sh(w.env, w.target, 'status', '--porcelain') }, before)
})

test('NO BUNDLE, the measured case: the source pushed, the target never fetched — cat-file fails, one fetch, and it passes', async () => {
  const w = await world()
  await put(w.source, 'pushed.txt', 'pushed\n')
  const pushed = await commitAll(w.env, w.source, 'pushed')
  await sh(w.env, w.source, 'push', '--quiet')
  // Nothing the remote lacks: there is no bundle.
  assert.equal(await sh(w.env, w.source, 'rev-list', '--count', pushed, '--not', '--remotes=origin'), '0')
  assert.equal(await ensureBase(w.target, { head: pushed }, w.env), 'fetched')
  await sh(w.env, w.target, 'cat-file', '-e', `${pushed}^{commit}`)
})

test('no bundle and a head that is not on the remote: bundle-base-missing, nothing touched', async () => {
  const w = await world()
  await put(w.source, 'private.txt', 'x\n')
  const local = await commitAll(w.env, w.source, 'local')
  assert.equal(await ensureBase(w.target, { head: local }, w.env), 'missing')
})

test('no bundle and a head the target already has: present, without a fetch', async () => {
  const w = await world()
  assert.equal(await ensureBase(w.target, { head: await sh(w.env, w.target, 'rev-parse', 'HEAD') }, w.env), 'present')
})

test('importBundle brings refs/factotum/handoff/<hid>/{head,wip} and does not touch the tree', async () => {
  const w = await world()
  const made = await workOnSource(w)
  const out = await bundlePath(w)
  await makeBundle(w.source, { hid: HID, head: made.head, wip: made.wip, base: handoffBase(undefined), out, env: w.env })
  const before = { head: await sh(w.env, w.target, 'rev-parse', 'HEAD'), status: await sh(w.env, w.target, 'status', '--porcelain') }
  await importBundle(w.target, { bundle: out, hid: HID, env: w.env })
  assert.equal(await sh(w.env, w.target, 'rev-parse', `refs/factotum/handoff/${HID}/head`), made.head)
  assert.equal(await sh(w.env, w.target, 'rev-parse', `refs/factotum/handoff/${HID}/wip`), made.wip)
  assert.deepEqual({ head: await sh(w.env, w.target, 'rev-parse', 'HEAD'), status: await sh(w.env, w.target, 'status', '--porcelain') }, before)
})
