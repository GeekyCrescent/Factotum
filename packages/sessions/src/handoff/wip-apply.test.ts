import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { commitAll, indexPath, put, sh, world, type World } from './test-repos.ts'
import { applyWip, cleanSource, ignoredCollisions, wipCommit, wipTree } from './wip.ts'
import { handoffBase, importBundle, makeBundle } from './git-bundle.ts'
import { handoffGit } from './git.ts'

const HID = '0199e0c0-0000-7000-8000-000000000003'

/** The whole path of the code for one project, source to target, as the `commit` runs it (design D9). */
async function carryAndMerge(w: World): Promise<{ readonly head: string; readonly wip: string; readonly tree: string }> {
  const made = await wipCommit(w.source, { indexFile: await indexPath(w), hid: HID, host: 'mac', base: w.env })
  const out = join(await mkdtemp(join(w.home, 'state-')), 'code.bundle')
  await makeBundle(w.source, { hid: HID, head: made.head, wip: made.wip, base: handoffBase(undefined), out, env: w.env })
  await importBundle(w.target, { bundle: out, hid: HID, env: w.env })
  await handoffGit(w.target, ['merge', '--ff-only', '--no-overwrite-ignore', made.head], { base: w.env })
  return { head: made.head, wip: made.wip ?? '', tree: made.tree }
}

// ---------------------------------------------------------------------------
// G5 — applyWip (design D10): read-tree -m -u, the check BEFORE reset -q, wip-apply-failed if not
// ---------------------------------------------------------------------------

test('a new file, a deleted one, a binary and a staged one arrive, and the target’s wipTree is the source’s (criterion 26)', async () => {
  const w = await world()
  await put(w.source, 'gone.txt', 'to delete\n')
  await put(w.source, 'local.txt', 'a local commit\n')
  await commitAll(w.env, w.source, 'local')
  await put(w.source, 'new.txt', 'new\n')
  await unlink(join(w.source, 'gone.txt'))
  await put(w.source, 'image.bin', Buffer.from([0, 1, 2, 255, 0, 10, 13, 0]))
  await put(w.source, 'staged.txt', 'staged\n')
  await sh(w.env, w.source, 'add', 'staged.txt')
  await put(w.source, 'a.txt', 'modified\n')
  // Porcelain settings that would wreck a patch: plumbing does not care.
  await sh(w.env, w.target, 'config', 'color.ui', 'always')
  await sh(w.env, w.target, 'config', 'diff.noprefix', 'true')

  const carried = await carryAndMerge(w)
  assert.equal(await applyWip(w.target, carried.wip, w.env), 'applied')

  assert.equal(await sh(w.env, w.target, 'rev-parse', 'HEAD'), carried.head)
  assert.equal(await wipTree(w.target, { indexFile: await indexPath(w), base: w.env }), carried.tree)
  // As uncommitted changes, nothing staged: the index is HEAD again.
  assert.equal(await sh(w.env, w.target, 'diff', '--cached', '--name-only'), '')
  assert.deepEqual(await readFile(join(w.target, 'image.bin')), Buffer.from([0, 1, 2, 255, 0, 10, 13, 0]))
  await assert.rejects(lstat(join(w.target, 'gone.txt')))
})

test('a file of the WIP that the target ignores (and does not have) passes the check: no false wip-apply-failed (criterion 27c)', async () => {
  const w = await world()
  await put(w.source, 'secret.local', 'S-src\n')
  await put(w.source, 'a.txt', 'changed\n')
  await writeFile(join(w.target, '.git', 'info', 'exclude'), 'secret.local\n')
  const carried = await carryAndMerge(w)
  assert.equal(await applyWip(w.target, carried.wip, w.env), 'applied')
  assert.equal(await readFile(join(w.target, 'secret.local'), 'utf8'), 'S-src\n')
})

test('a stale stat in the index is refreshed before diff-files: a touched but equal file is not a failure', async () => {
  const w = await world()
  await put(w.source, 'b.txt', 'b\n')
  const carried = await carryAndMerge(w)
  // The owner's a.txt is rewritten with the same bytes: the stat changes, the content does not.
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  await writeFile(join(w.target, 'a.txt'), 'a\n')
  assert.equal(await applyWip(w.target, carried.wip, w.env), 'applied')
})

test('a working tree that does not match after read-tree is wip-apply-failed, and the index is left for the undo', async () => {
  const w = await world()
  await put(w.source, 'b.txt', 'b\n')
  const carried = await carryAndMerge(w)
  // An untracked, NOT ignored, file where the WIP adds one: read-tree refuses.
  await put(w.target, 'b.txt', 'the owner’s\n')
  assert.equal(await applyWip(w.target, carried.wip, w.env), 'wip-apply-failed')
  assert.equal(await readFile(join(w.target, 'b.txt'), 'utf8'), 'the owner’s\n')
})

// ---------------------------------------------------------------------------
// G5b — ignoredCollisions (design D10, the v4.3 rule)
// ---------------------------------------------------------------------------

type Rule = 'info' | 'excludesFile'

/** The target's ignore rules, outside the repo, one way or the other. */
async function ignoreOnTarget(w: World, rule: Rule, lines: string): Promise<void> {
  if (rule === 'info') {
    await writeFile(join(w.target, '.git', 'info', 'exclude'), lines)
    return
  }
  const file = join(w.home, 'target-excludes')
  await writeFile(file, lines)
  await sh(w.env, w.target, 'config', 'core.excludesFile', file)
}

/** A WIP on the source built from `files`, imported on the target. Returns prevHead and the WIP. */
async function wipOnTarget(w: World, files: Record<string, string | null>): Promise<{ readonly prevHead: string; readonly wip: string }> {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) await rm(join(w.source, file), { recursive: true, force: true })
    else await put(w.source, file, content)
  }
  // Forced: on the source nothing is ignored, but the test must not depend on that.
  const made = await wipCommit(w.source, { indexFile: await indexPath(w), hid: HID, host: 'mac', base: w.env })
  await sh(w.env, w.source, 'update-ref', 'refs/test/wip', made.wip ?? '')
  await sh(w.env, w.target, 'fetch', '--quiet', w.source, '+refs/test/wip:refs/test/wip')
  return { prevHead: await sh(w.env, w.target, 'rev-parse', 'HEAD'), wip: made.wip ?? '' }
}

function counting(w: World) {
  const calls: string[][] = []
  const git = async (args: readonly string[]) => {
    calls.push([...args])
    return await handoffGit(w.target, args, { base: w.env })
  }
  return { calls, git, statuses: () => calls.filter((args) => args[0] === 'status').length }
}

for (const rule of ['info', 'excludesFile'] as const) {
  test(`[${rule}] the WIP creates secret.local, which the target has and ignores: it is returned, and nothing changes`, async () => {
    const w = await world()
    await ignoreOnTarget(w, rule, 'secret.local\n')
    await put(w.target, 'secret.local', 'S-tgt\n')
    const { prevHead, wip } = await wipOnTarget(w, { 'secret.local': 'S-src\n' })
    assert.deepEqual(await ignoredCollisions(w.target, prevHead, wip, { env: w.env }), ['secret.local'])
    assert.equal(await readFile(join(w.target, 'secret.local'), 'utf8'), 'S-tgt\n')
  })

  test(`[${rule}] the same with a commit of the bundle that creates it, and no WIP (final = head)`, async () => {
    const w = await world()
    await ignoreOnTarget(w, rule, 'secret.local\n')
    await put(w.target, 'secret.local', 'S-tgt\n')
    await put(w.source, 'secret.local', 'S-src\n')
    const head = await commitAll(w.env, w.source, 'adds it')
    await sh(w.env, w.source, 'update-ref', 'refs/test/head', head)
    await sh(w.env, w.target, 'fetch', '--quiet', w.source, 'refs/test/head:refs/test/head')
    const prevHead = await sh(w.env, w.target, 'rev-parse', 'HEAD')
    assert.deepEqual(await ignoredCollisions(w.target, prevHead, head, { env: w.env }), ['secret.local'])
  })

  test(`[${rule}] the WIP adds the FILE foo and the target has the folder foo/ with only foo/a.log, ignored (v4.3)`, async () => {
    const w = await world()
    await ignoreOnTarget(w, rule, '*.log\n')
    await put(w.target, 'foo/a.log', 'owner log\n')
    const { prevHead, wip } = await wipOnTarget(w, { foo: 'a file now\n' })
    assert.deepEqual(await ignoredCollisions(w.target, prevHead, wip, { env: w.env }), ['foo'])
    assert.equal(await readFile(join(w.target, 'foo', 'a.log'), 'utf8'), 'owner log\n')
  })

  test(`[${rule}] a folder of the path that exists as an ignored FILE (the WIP adds bar/x, the target has bar)`, async () => {
    const w = await world()
    await ignoreOnTarget(w, rule, 'bar\n')
    await put(w.target, 'bar', 'owner file\n')
    const { prevHead, wip } = await wipOnTarget(w, { 'bar/x': 'x\n' })
    assert.deepEqual(await ignoredCollisions(w.target, prevHead, wip, { env: w.env }), ['bar'])
  })

  test(`[${rule}] a tracked folder the WIP turns into a file, with an ignored file inside (dd/x.log)`, async () => {
    const w = await world()
    await put(w.source, 'dd/t.txt', 't\n')
    await commitAll(w.env, w.source, 'dd')
    await sh(w.env, w.source, 'push', '--quiet')
    await sh(w.env, w.target, 'pull', '--quiet')
    await ignoreOnTarget(w, rule, '*.log\n')
    await put(w.target, 'dd/x.log', 'owner log\n')
    await rm(join(w.source, 'dd'), { recursive: true })
    const { prevHead, wip } = await wipOnTarget(w, { dd: 'now a file\n' })
    assert.deepEqual(await ignoredCollisions(w.target, prevHead, wip, { env: w.env }), ['dd'])
  })

  test(`[${rule}] no false positives: folder → file and file → folder over tracked clean paths, and a new path inside an ignored folder that does not exist`, async () => {
    const w = await world()
    await put(w.source, 'dd/t.txt', 't\n')
    await put(w.source, 'f', 'f\n')
    await commitAll(w.env, w.source, 'shapes')
    await sh(w.env, w.source, 'push', '--quiet')
    await sh(w.env, w.target, 'pull', '--quiet')
    await ignoreOnTarget(w, rule, 'cache/\n')
    await rm(join(w.source, 'dd'), { recursive: true })
    await rm(join(w.source, 'f'))
    const { prevHead, wip } = await wipOnTarget(w, { dd: 'file\n', 'f/x': 'x\n', 'cache/new.txt': 'new\n' })
    assert.deepEqual(await ignoredCollisions(w.target, prevHead, wip, { env: w.env }), [])
  })
}

test('with a symlink the target ignores where the WIP adds a file: it collides', async () => {
  const w = await world()
  await ignoreOnTarget(w, 'excludesFile', 'lnk\n')
  await symlink('/tmp', join(w.target, 'lnk'))
  const { prevHead, wip } = await wipOnTarget(w, { lnk: 'a file\n' })
  assert.deepEqual(await ignoredCollisions(w.target, prevHead, wip, { env: w.env }), ['lnk'])
})

test('nothing on disk: empty, without asking git for status (lstat only)', async () => {
  const w = await world()
  await ignoreOnTarget(w, 'info', '*.local\n')
  const { prevHead, wip } = await wipOnTarget(w, { 'new.local': 'n\n', 'other.txt': 'o\n' })
  const run = counting(w)
  assert.deepEqual(await ignoredCollisions(w.target, prevHead, wip, { env: w.env, git: run.git }), [])
  assert.equal(run.statuses(), 0)
})

test('more candidates than one batch: several calls, the same result', async () => {
  const w = await world()
  await ignoreOnTarget(w, 'info', '*.log\n')
  const files: Record<string, string> = {}
  for (let i = 0; i < 7; i += 1) {
    files[`f${i}.log`] = 'src\n'
    await put(w.target, `f${i}.log`, 'tgt\n')
  }
  const { prevHead, wip } = await wipOnTarget(w, files)
  const one = await ignoredCollisions(w.target, prevHead, wip, { env: w.env })
  const run = counting(w)
  const many = await ignoredCollisions(w.target, prevHead, wip, { env: w.env, git: run.git, batchSize: 3 })
  assert.deepEqual(many, one)
  assert.equal(one.length, 7)
  assert.equal(run.statuses(), 3)
})

test('what the WIP MODIFIES or DELETES does not count', async () => {
  const w = await world()
  await put(w.source, 'm.log', 'm\n')
  await put(w.source, 'd.log', 'd\n')
  await commitAll(w.env, w.source, 'logs')
  await sh(w.env, w.source, 'push', '--quiet')
  await sh(w.env, w.target, 'pull', '--quiet')
  await ignoreOnTarget(w, 'info', '*.log\n')
  const { prevHead, wip } = await wipOnTarget(w, { 'm.log': 'changed\n', 'd.log': null })
  assert.deepEqual(await ignoredCollisions(w.target, prevHead, wip, { env: w.env }), [])
})

// ---------------------------------------------------------------------------
// G6 — cleanSource (criterion 31)
// ---------------------------------------------------------------------------

async function sourceWithWip(w: World) {
  await put(w.source, '.gitignore', '.env.local\n')
  await commitAll(w.env, w.source, 'ignore')
  await put(w.source, '.env.local', 'SECRET\n')
  await put(w.source, 'wip.txt', 'half\n')
  await put(w.source, 'a.txt', 'changed\n')
  return await wipCommit(w.source, { indexFile: await indexPath(w), hid: HID, host: 'mac', base: w.env })
}

test('the same tree and HEAD: cleaned, with the backup ref, and .env.local survives', async () => {
  const w = await world()
  const made = await sourceWithWip(w)
  const outcome = await cleanSource(w.source, { hid: HID, head: made.head, wip: made.wip, tree: made.tree, indexFile: await indexPath(w), env: w.env })
  assert.equal(outcome, 'cleaned')
  assert.equal(await sh(w.env, w.source, 'status', '--porcelain'), '')
  assert.equal(await sh(w.env, w.source, 'rev-parse', `refs/factotum/handoff-backup/${HID}`), made.wip)
  assert.equal(await readFile(join(w.source, '.env.local'), 'utf8'), 'SECRET\n')
})

test('a tree that changed during the handoff is not cleaned', async () => {
  const w = await world()
  const made = await sourceWithWip(w)
  await put(w.source, 'later.txt', 'typed after the WIP\n')
  const outcome = await cleanSource(w.source, { hid: HID, head: made.head, wip: made.wip, tree: made.tree, indexFile: await indexPath(w), env: w.env })
  assert.equal(outcome, 'source-changed-during-handoff')
  assert.equal(await readFile(join(w.source, 'later.txt'), 'utf8'), 'typed after the WIP\n')
  assert.equal(await readFile(join(w.source, 'wip.txt'), 'utf8'), 'half\n')
})

test('a HEAD that moved during the handoff is not cleaned', async () => {
  const w = await world()
  const made = await sourceWithWip(w)
  await sh(w.env, w.source, 'commit', '--quiet', '--allow-empty', '-m', 'the plugin committed')
  const outcome = await cleanSource(w.source, { hid: HID, head: made.head, wip: made.wip, tree: made.tree, indexFile: await indexPath(w), env: w.env })
  assert.equal(outcome, 'source-changed-during-handoff')
  assert.equal(await readFile(join(w.source, 'wip.txt'), 'utf8'), 'half\n')
})

test('with no WIP there is nothing to back up, and a clean tree stays clean', async () => {
  const w = await world()
  const made = await wipCommit(w.source, { indexFile: await indexPath(w), hid: HID, host: 'mac', base: w.env })
  const outcome = await cleanSource(w.source, { hid: HID, head: made.head, wip: undefined, tree: made.tree, indexFile: await indexPath(w), env: w.env })
  assert.equal(outcome, 'cleaned')
  assert.equal(await sh(w.env, w.source, 'for-each-ref', 'refs/factotum/'), '')
})

test('an untracked folder of the WIP goes too (clean -fd)', async () => {
  const w = await world()
  await mkdir(join(w.source, 'newdir'))
  await put(w.source, 'newdir/x.txt', 'x\n')
  const made = await wipCommit(w.source, { indexFile: await indexPath(w), hid: HID, host: 'mac', base: w.env })
  assert.equal(await cleanSource(w.source, { hid: HID, head: made.head, wip: made.wip, tree: made.tree, indexFile: await indexPath(w), env: w.env }), 'cleaned')
  await assert.rejects(lstat(join(w.source, 'newdir')))
})
