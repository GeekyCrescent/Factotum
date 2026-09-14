import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contains, insideSite, inspectSite, resolveAgainst, type Site } from './sites.ts'

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'factotum-sites-'))
}

// ---------------------------------------------------------------------------
// contains — the separator is the whole point
// ---------------------------------------------------------------------------

test('a path inside the root is inside it', () => {
  assert.equal(contains('/a/b', '/a/b/c/d.txt'), true)
})

test('the root itself counts as inside', () => {
  assert.equal(contains('/a/b', '/a/b'), true)
})

test('a sibling whose name merely starts the same is NOT inside', () => {
  // Without the separator, `/a/bc` passes for being under `/a/b` — a different
  // directory the owner never authorised.
  assert.equal(contains('/a/b', '/a/bc/secret.txt'), false)
})

test('a parent is not inside its child', () => {
  assert.equal(contains('/a/b/c', '/a/b'), false)
})

test('a trailing separator on the root changes nothing', () => {
  assert.equal(contains('/a/b/', '/a/b/c'), true)
  assert.equal(contains('/a/b/', '/a/bc'), false)
})

test('a traversal that climbs back out is not inside', () => {
  assert.equal(contains('/a/b', '/a/b/../../etc/passwd'), false)
})

// ---------------------------------------------------------------------------
// resolveAgainst
// ---------------------------------------------------------------------------

test('a relative target resolves against the session cwd, not the daemon cwd', () => {
  assert.equal(resolveAgainst('/work/site', 'notes/x.md'), '/work/site/notes/x.md')
})

test('an absolute target is left alone', () => {
  assert.equal(resolveAgainst('/work/site', '/etc/passwd'), '/etc/passwd')
})

test('a relative target can still climb out, and that is the point of checking after', () => {
  assert.equal(resolveAgainst('/work/site', '../elsewhere/x'), '/work/elsewhere/x')
})

// ---------------------------------------------------------------------------
// inspectSite — the I/O half, which only ever runs from start()
// ---------------------------------------------------------------------------

test('a declared directory that exists inspects cleanly and is not a repo', async () => {
  const root = await scratch()
  const site = await inspectSite({ id: 'work', path: root })
  assert.equal(site.id, 'work')
  assert.equal(site.isRepo, false)
})

test('a directory with a .git inside is a repo', async () => {
  const root = await scratch()
  await mkdir(join(root, '.git'))
  assert.equal((await inspectSite({ id: 'work', path: root })).isRepo, true)
})

test('a worktree, whose .git is a FILE, is still a repo', async () => {
  const root = await scratch()
  await writeFile(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n')
  assert.equal((await inspectSite({ id: 'work', path: root })).isRepo, true)
})

test('a path that does not exist throws, so step 12 disables the module with the reason', async () => {
  await assert.rejects(
    () => inspectSite({ id: 'gone', path: '/definitely/not/here' }),
    /site "gone": .*does not exist/,
  )
})

test('a path that is a file and not a directory throws', async () => {
  const root = await scratch()
  const file = join(root, 'a-file')
  await writeFile(file, 'x')
  await assert.rejects(() => inspectSite({ id: 'f', path: file }), /is not a directory/)
})

test('a relative path throws rather than being resolved against whatever cwd this is', async () => {
  await assert.rejects(() => inspectSite({ id: 'rel', path: 'relative/path' }), /is not absolute/)
})

// ---------------------------------------------------------------------------
// insideSite — both spellings, because of the macOS /tmp symlink
// ---------------------------------------------------------------------------

test('a site reached through a symlink is inside under BOTH spellings', async () => {
  // This is not hypothetical: on macOS `/tmp` IS a symlink to `/private/tmp`, the CLI
  // reports resolved paths in `cwd` and builds `file_path` from them, so a site
  // declared as `/tmp/x` receives tool inputs under `/private/tmp/x`.
  //
  // The two spellings covered are THE DECLARED ONE AND ITS RESOLUTION, which are the
  // two that occur: the owner writes one, the CLI reports the other. A third alias —
  // some other symlink nobody declared — is not covered, and resolving the target
  // would mean I/O inside `decide`, which D13 keeps pure. It fails to a deny, which is
  // the safe direction.
  const real = await scratch()
  const linkHome = await scratch()
  const link = join(linkHome, 'link-to-site')
  await symlink(real, link)

  const site = await inspectSite({ id: 'work', path: link })
  assert.notEqual(site.path, site.realPath)
  assert.equal(insideSite(site, join(link, 'a.txt')), true)
  assert.equal(insideSite(site, join(await realpath(real), 'a.txt')), true)
  assert.equal(insideSite(site, join(linkHome, 'outside.txt')), false)
})

test('outside is outside under either spelling', () => {
  const site: Site = { id: 'x', path: '/tmp/site', realPath: '/private/tmp/site', isRepo: false }
  assert.equal(insideSite(site, '/tmp/site/ok.txt'), true)
  assert.equal(insideSite(site, '/private/tmp/site/ok.txt'), true)
  assert.equal(insideSite(site, '/tmp/other/no.txt'), false)
  assert.equal(insideSite(site, '/etc/passwd'), false)
})
