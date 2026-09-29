import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Timers } from '@factotum/core'
import {
  canonicalPath,
  checkCandidate,
  checkSite,
  contains,
  insideSite,
  inspectSite,
  resolveAgainst,
  type CandidateWorld,
  type DiskProbe,
  type Site,
} from './sites.ts'

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

// ---------------------------------------------------------------------------
// checkSite, canonicalPath, checkCandidate (spec 2026-09-29, criteria 12, 13, 15, 23)
// ---------------------------------------------------------------------------

const realTimers: Timers = {
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

/** Timers a test fires by hand: the 5 s ceiling is tested without waiting 5 s. */
function manualTimers(): { timers: Timers; fire: () => void; armed: () => number } {
  const due = new Set<() => void>()
  const arm = (fn: () => void) => {
    due.add(fn)
    return { [Symbol.dispose]: () => void due.delete(fn) }
  }
  return {
    timers: { setTimeout: arm, setInterval: arm },
    fire: () => {
      for (const fn of [...due]) {
        due.delete(fn)
        fn()
      }
    },
    armed: () => due.size,
  }
}

async function candidateWorld(extra: Partial<CandidateWorld> = {}): Promise<CandidateWorld & { root: string }> {
  const root = await realpath(await scratch())
  const home = join(root, 'home')
  await mkdir(join(home, '.factotum', 'prod'), { recursive: true })
  return {
    root,
    home,
    factotumRoot: join(home, '.factotum'),
    installRoot: undefined,
    projects: [],
    shared: [],
    timers: realTimers,
    caseInsensitive: false,
    ...extra,
  }
}

test('checkSite: a folder that is there is ok; one that is not is MISSING, with why, and never throws', async () => {
  const dir = await scratch()
  const ok = await checkSite({ id: 'a', path: dir })
  assert.equal(ok.status, 'ok')
  const gone = await checkSite({ id: 'b', path: join(dir, 'nope') })
  assert.equal(gone.status, 'missing')
  assert.match(gone.status === 'missing' ? gone.reason : '', /does not exist/)
})

test('canonicalPath resolves the nearest ancestor that exists and keeps the missing tail as typed', async () => {
  const dir = await scratch()
  const real = await realpath(dir)
  assert.equal(await canonicalPath(join(dir, 'Gone', 'deeper')), join(real, 'Gone', 'deeper'))
  assert.equal(await canonicalPath(`${dir}/`), real)
  assert.equal(await canonicalPath('/definitely-not-here-factotum/x'), '/definitely-not-here-factotum/x')
})

test('a candidate that is a folder is ok, with its RESOLVED path and base', async () => {
  const world = await candidateWorld()
  const dir = join(world.root, 'web')
  await mkdir(dir)
  assert.deepEqual(await checkCandidate(dir, 'project', world), { ok: true, realPath: dir, base: 'web' })
})

test('A SYMLINK registers its target: the id and the notice come from the target’s name (criterion 13)', async () => {
  const world = await candidateWorld()
  const target = join(world.root, 'real-name')
  await mkdir(target)
  const link = join(world.root, 'alias')
  await symlink(target, link)
  assert.deepEqual(await checkCandidate(link, 'project', world), { ok: true, realPath: target, base: 'real-name' })
})

test('a symlink INTO a forbidden folder is refused by where it lands (criterion 13)', async () => {
  const world = await candidateWorld()
  const link = join(world.root, 'sneaky')
  await symlink(world.factotumRoot, link)
  const result = await checkCandidate(link, 'project', world)
  assert.equal(result.ok, false)
})

test('missing, not a folder, `/`, and the home are refused (criterion 12)', async () => {
  const world = await candidateWorld()
  const file = join(world.root, 'file.txt')
  await writeFile(file, 'x')
  const reasons: string[] = []
  for (const path of [join(world.root, 'nope'), file, '/', world.home]) {
    const result = await checkCandidate(path, 'project', world)
    assert.equal(result.ok, false, path)
    reasons.push(result.ok ? '' : result.reason)
  }
  assert.match(reasons[0] ?? '', /does not exist/)
  assert.match(reasons[1] ?? '', /not a folder/)
  assert.match(reasons[2] ?? '', /root of the disk/)
  assert.match(reasons[3] ?? '', /home folder/)
})

test('~/.factotum, what is inside it, and what is above it are refused; a sibling under home is fine (criterion 12)', async () => {
  const world = await candidateWorld()
  const sibling = join(world.home, 'code')
  await mkdir(sibling)
  for (const path of [world.factotumRoot, join(world.factotumRoot, 'prod'), world.root]) {
    assert.equal((await checkCandidate(path, 'project', world)).ok, false, path)
    assert.equal((await checkCandidate(path, 'shared', world)).ok, false, `shared ${path}`)
  }
  assert.equal((await checkCandidate(sibling, 'project', world)).ok, true)
})

test('the checkout factotum runs from is refused like ~/.factotum, inside and above (ADR-0011)', async () => {
  const world = await candidateWorld()
  const install = join(world.root, 'src', 'Factotum')
  await mkdir(join(install, 'packages'), { recursive: true })
  const withInstall = { ...world, installRoot: install }
  for (const path of [install, join(install, 'packages'), join(world.root, 'src')]) {
    assert.equal((await checkCandidate(path, 'project', withInstall)).ok, false, path)
  }
  const worktree = join(world.root, 'src', 'Factotum-projects')
  await mkdir(worktree)
  assert.equal((await checkCandidate(worktree, 'project', withInstall)).ok, true, 'another checkout is fine')
})

test('a project may not equal, contain or sit inside another — EVEN ONE WHOSE FOLDER IS GONE (criterion 12)', async () => {
  const world = await candidateWorld()
  const existing = join(world.root, 'a')
  await mkdir(join(existing, 'inner'), { recursive: true })
  const gone = join(world.root, 'tmp', 'factotum-proyecto-a')
  await mkdir(join(world.root, 'tmp'))
  const projects = [
    { id: 'a', path: existing },
    { id: 'proyecto-a', path: gone },
  ]
  const w = { ...world, projects }
  assert.match(String((await checkCandidate(existing, 'project', w) as { reason?: string }).reason), /already the project "a"/)
  assert.match(String((await checkCandidate(join(existing, 'inner'), 'project', w) as { reason?: string }).reason), /inside the project "a"/)
  // `/tmp` does not pass because `/tmp/factotum-proyecto-a` happens to be missing today.
  assert.match(String((await checkCandidate(join(world.root, 'tmp'), 'project', w) as { reason?: string }).reason), /contains the project "proyecto-a"/)
})

test('ON macOS THE RULES DO NOT TELL CASES APART, because the disk does not (criterion 12)', async () => {
  const dirs = new Set(['/', '/Users', '/Users/me', '/Users/me/Code', '/Users/me/Code/web'])
  const disk: DiskProbe = {
    realpath: async (path) => {
      // Like APFS: found whatever the case, answered as typed.
      if ([...dirs].some((d) => d.toLowerCase() === path.toLowerCase())) return path
      throw new Error('ENOENT')
    },
    isDirectory: async () => true,
  }
  const world: CandidateWorld = {
    home: '/Users/me',
    factotumRoot: '/Users/me/.factotum',
    installRoot: undefined,
    projects: [{ id: 'web', path: '/Users/me/Code/web' }],
    shared: [],
    timers: realTimers,
    caseInsensitive: true,
    disk,
  }
  assert.equal((await checkCandidate('/users/me/code/WEB', 'project', world)).ok, false)
  assert.equal((await checkCandidate('/Users/me/code', 'project', world)).ok, false, 'above it, in another case')
  assert.equal((await checkCandidate('/Users/me/code/web', 'project', { ...world, caseInsensitive: false })).ok, true, 'Linux: another folder')
})

test('A SHARED FOLDER may sit inside a project, but may not repeat nor be forbidden (criterion 12)', async () => {
  const world = await candidateWorld()
  const project = join(world.root, 'vault-project')
  const notes = join(project, 'notes')
  await mkdir(notes, { recursive: true })
  const w = { ...world, projects: [{ id: 'vault-project', path: project }], shared: [notes] }
  assert.equal((await checkCandidate(join(project), 'shared', { ...w, shared: [] })).ok, true, 'the project itself, shared')
  assert.match(String((await checkCandidate(notes, 'shared', w) as { reason?: string }).reason), /already shared/)
  assert.equal((await checkCandidate(world.home, 'shared', w)).ok, false)
})

test('A CHECK THAT NEVER ENDS is abandoned at the ceiling: `timed out`, and its timer is the kernel’s (criterion 15)', async () => {
  const manual = manualTimers()
  const hung: DiskProbe = { realpath: () => new Promise<string>(() => undefined), isDirectory: async () => true }
  const pending = checkCandidate('/mnt/hung', 'project', {
    home: '/h',
    factotumRoot: '/h/.factotum',
    installRoot: undefined,
    projects: [],
    shared: [],
    timers: manual.timers,
    caseInsensitive: false,
    disk: hung,
  })
  assert.equal(manual.armed(), 1)
  manual.fire()
  assert.deepEqual(await pending, { ok: false, reason: 'checking that folder timed out' })
})

test('a check that ends in time disarms its ceiling', async () => {
  const manual = manualTimers()
  const world = await candidateWorld({ timers: manual.timers })
  const dir = join(world.root, 'quick')
  await mkdir(dir)
  assert.equal((await checkCandidate(dir, 'project', world)).ok, true)
  assert.equal(manual.armed(), 0)
})
