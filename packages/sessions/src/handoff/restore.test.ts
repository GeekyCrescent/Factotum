import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { carry, commitAll, indexPath, put, sh, world, type World } from '../test-repos.ts'
import { applyWip, wipCommit } from './wip.ts'
import { handoffGit } from './git.ts'
import { restoreTarget, type RestoreOptions } from './restore.ts'

const HID = '0199e0c0-0000-7000-8000-000000000004'

type Until = 'nothing' | 'checkout' | 'merge' | 'apply'

interface Scenario {
  /** The handoff's branch: the source's checkout. */
  readonly branch: string
  /** Whether the target already has `branch` (at an ancestor of the source's HEAD). */
  readonly targetHasBranch: boolean
  /** Where the target is when `prepare` runs: a branch, or detached. */
  readonly targetOn: 'main' | 'branch' | 'detached'
}

/**
 * The source's work, and the target as `prepare` leaves it: the journal's fields as `prepare`
 * writes them (design D9, D11). Nothing of `installing` has run yet.
 */
async function prepared(w: World, scenario: Scenario): Promise<RestoreOptions> {
  const { branch } = scenario
  if (branch !== 'main') {
    await sh(w.env, w.source, 'checkout', '--quiet', '-b', branch)
    await put(w.source, 'feature-base.txt', 'pushed feature\n')
    await commitAll(w.env, w.source, 'feature base')
    await sh(w.env, w.source, 'push', '--quiet', '-u', 'origin', branch)
  }
  if (scenario.targetHasBranch && branch !== 'main') {
    await sh(w.env, w.target, 'fetch', '--quiet', 'origin')
    await sh(w.env, w.target, 'branch', branch, `origin/${branch}`)
  }
  if (scenario.targetOn === 'branch') await sh(w.env, w.target, 'checkout', '--quiet', branch)
  if (scenario.targetOn === 'detached') await sh(w.env, w.target, 'checkout', '--quiet', '--detach', 'HEAD')

  // The source's local commit and WIP, carried as the bundle would.
  await put(w.source, 'local.txt', 'local\n')
  await commitAll(w.env, w.source, 'local')
  await put(w.source, 'wip.txt', 'wip\n')
  await put(w.source, 'secret.local', 'from the source\n')
  const made = await wipCommit(w.source, { indexFile: await indexPath(w), hid: HID, host: 'mac', base: w.env })
  await carry(w, w.source, w.target, made.wip ?? '')

  const prevBranch = scenario.targetOn === 'detached' ? undefined : await sh(w.env, w.target, 'symbolic-ref', '--short', 'HEAD')
  const branchHead = (await sh(w.env, w.target, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`).catch(() => '')) || undefined
  return {
    hid: HID,
    branch,
    prevBranch,
    prevHead: await sh(w.env, w.target, 'rev-parse', 'HEAD'),
    branchHead,
    branchCreated: branchHead === undefined,
    head: made.head,
    wip: made.wip,
    indexFile: await indexPath(w),
    env: w.env,
  }
}

/** `installing` up to `until`, as `target.ts` runs it: checkout, merge --ff-only, applyWip. */
async function install(w: World, options: RestoreOptions, until: Until): Promise<void> {
  const git = (...args: string[]) => handoffGit(w.target, args, { base: w.env })
  if (until === 'nothing') return
  if (options.prevBranch !== options.branch) {
    if (options.branchCreated) await git('checkout', '-q', '--no-overwrite-ignore', '-b', options.branch, options.head)
    else await git('checkout', '-q', '--no-overwrite-ignore', options.branch)
  }
  if (until === 'checkout') return
  await git('merge', '-q', '--ff-only', '--no-overwrite-ignore', options.head)
  if (until === 'merge') return
  assert.equal(await applyWip(w.target, options.wip ?? '', w.env), 'applied')
}

async function snapshot(w: World) {
  return {
    head: await sh(w.env, w.target, 'rev-parse', 'HEAD'),
    branch: await sh(w.env, w.target, 'symbolic-ref', '-q', '--short', 'HEAD').catch(() => 'DETACHED'),
    status: await sh(w.env, w.target, 'status', '--porcelain', '--ignored'),
    heads: await sh(w.env, w.target, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'),
  }
}

const rescueRef = (w: World) => sh(w.env, w.target, 'for-each-ref', 'refs/factotum/handoff-rescue/')

async function roundTrip(scenario: Scenario, until: Until, setup: (w: World) => Promise<void> = async () => undefined) {
  const w = await world()
  await setup(w)
  const options = await prepared(w, scenario)
  const before = await snapshot(w)
  await install(w, options, until)
  return { w, options, before }
}

test('another prevBranch, the branch existed, applyWip done: the tree as before AND refs/heads/<branch> back to branchHead', async () => {
  const { w, options, before } = await roundTrip({ branch: 'feature', targetHasBranch: true, targetOn: 'main' }, 'apply')
  assert.notEqual(await sh(w.env, w.target, 'rev-parse', 'refs/heads/feature'), options.branchHead, 'the merge moved it')
  const result = await restoreTarget(w.target, options)
  assert.deepEqual(await snapshot(w), before)
  assert.equal(await sh(w.env, w.target, 'rev-parse', 'refs/heads/feature'), options.branchHead)
  assert.equal(result.rescued, false)
  assert.equal(await rescueRef(w), '')
})

test('prevBranch IS the handoff’s branch: it is left at prevHead', async () => {
  const { w, options, before } = await roundTrip({ branch: 'main', targetHasBranch: true, targetOn: 'main' }, 'apply')
  assert.notEqual(await sh(w.env, w.target, 'rev-parse', 'HEAD'), options.prevHead)
  await restoreTarget(w.target, options)
  assert.deepEqual(await snapshot(w), before)
  assert.equal(await sh(w.env, w.target, 'rev-parse', 'refs/heads/main'), options.prevHead)
})

test('a target detached at the start goes back to it, and the handoff’s branch to branchHead', async () => {
  const { w, options, before } = await roundTrip({ branch: 'feature', targetHasBranch: true, targetOn: 'detached' }, 'apply')
  await restoreTarget(w.target, options)
  assert.deepEqual(await snapshot(w), before)
  assert.equal(before.branch, 'DETACHED')
})

test('with branchCreated the branch is deleted; with branchCreated and no branch (checkout -b never ran) it does not fail', async () => {
  const created = await roundTrip({ branch: 'feature', targetHasBranch: false, targetOn: 'main' }, 'apply')
  assert.equal(created.options.branchCreated, true)
  await restoreTarget(created.w.target, created.options)
  assert.deepEqual(await snapshot(created.w), created.before)

  const never = await roundTrip({ branch: 'feature', targetHasBranch: false, targetOn: 'main' }, 'nothing')
  await restoreTarget(never.w.target, never.options)
  assert.deepEqual(await snapshot(never.w), never.before)
})

test('a file edited by hand after applyWip is saved in refs/factotum/handoff-rescue/<hid> before the reset --hard', async () => {
  const { w, options, before } = await roundTrip({ branch: 'main', targetHasBranch: true, targetOn: 'main' }, 'apply')
  await writeFile(join(w.target, 'wip.txt'), 'Obsidian wrote this mid-handoff\n')
  const result = await restoreTarget(w.target, options)
  assert.equal(result.rescued, true)
  assert.equal(await sh(w.env, w.target, 'show', `refs/factotum/handoff-rescue/${HID}:wip.txt`), 'Obsidian wrote this mid-handoff')
  assert.deepEqual(await snapshot(w), before)
})

test('no false rescue: an undo after the merge and before applyWip, and one after the checkout of a branch that existed', async () => {
  const merged = await roundTrip({ branch: 'feature', targetHasBranch: true, targetOn: 'main' }, 'merge')
  assert.equal((await restoreTarget(merged.w.target, merged.options)).rescued, false)
  assert.equal(await rescueRef(merged.w), '')
  assert.deepEqual(await snapshot(merged.w), merged.before)

  const checkedOut = await roundTrip({ branch: 'feature', targetHasBranch: true, targetOn: 'main' }, 'checkout')
  assert.equal((await restoreTarget(checkedOut.w.target, checkedOut.options)).rescued, false)
  assert.equal(await rescueRef(checkedOut.w), '')
  assert.deepEqual(await snapshot(checkedOut.w), checkedOut.before)
})

test('a file of the WIP the target ignores: no false rescue, and the file does NOT stay; the owner’s own ignored file does (criterion 27c)', async () => {
  const { w, options, before } = await roundTrip({ branch: 'main', targetHasBranch: true, targetOn: 'main' }, 'apply', async (w) => {
    await writeFile(join(w.target, '.git', 'info', 'exclude'), '*.local\n')
    await put(w.target, 'mine.local', 'the owner’s\n')
  })
  assert.equal(await readFile(join(w.target, 'secret.local'), 'utf8'), 'from the source\n')

  const result = await restoreTarget(w.target, options)
  assert.equal(result.rescued, false)
  assert.equal(await rescueRef(w), '')
  assert.deepEqual(await snapshot(w), before)
  assert.doesNotMatch(await sh(w.env, w.target, 'status', '--porcelain', '--ignored'), /secret\.local/)
  assert.equal(await readFile(join(w.target, 'mine.local'), 'utf8'), 'the owner’s\n')
})
