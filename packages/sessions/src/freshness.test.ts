import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Timers } from '@factotum/core'
import { checkFreshness, describeFreshness, isFresh, pullIfSafe } from './freshness.ts'
import { runGit } from './git.ts'
import { SOLE_SKIPPED } from './locks.ts'
import { commitIn, git, head, pushFromOther, remoteWithClones, upstream } from './test-git.ts'
import type { FreshnessReport } from './types.ts'

/** Real timers, unrefd. The point of injecting them is that they can be disposed. */
function trackingTimers(): { timers: Timers; armed: number; disposed: () => number } {
  let armed = 0
  let disposed = 0
  const timers: Timers = {
    setInterval: () => ({ [Symbol.dispose]: () => undefined }),
    setTimeout: (fn, ms) => {
      armed += 1
      const handle = setTimeout(fn, ms)
      handle.unref()
      return {
        [Symbol.dispose]: () => {
          disposed += 1
          clearTimeout(handle)
        },
      }
    },
  }
  return { timers, get armed() { return armed }, disposed: () => disposed }
}

/** A git that answers from a script instead of from a repository. */
function fakeGit(answers: Record<string, string | Error>) {
  return async (args: readonly string[]): Promise<string> => {
    const key = args[0] ?? ''
    const answer = answers[key]
    if (answer instanceof Error) throw answer
    return answer ?? ''
  }
}

const CWD = '/work/site'

const CLEAN: FreshnessReport = {
  clean: true,
  behind: 0,
  dirtyFiles: [],
  remoteWarning: undefined,
  fetchFailed: false,
  noUpstream: false,
  pullError: undefined,
}

/** `soleSection` when this launch is the only holder: it just runs. */
const alone = <T>(fn: () => Promise<T>): Promise<T> => fn()

test('a clean repo that is up to date is fresh', async () => {
  const { timers } = trackingTimers()
  const report = await checkFreshness({
    cwd: CWD,
    timers,
    git: fakeGit({ status: '', fetch: '', 'rev-list': '0\n' }),
  })
  assert.deepEqual(report, {
    clean: true,
    behind: 0,
    dirtyFiles: [],
    remoteWarning: undefined,
    fetchFailed: false,
    noUpstream: false,
    pullError: undefined,
  })
  assert.equal(isFresh(report), true)
})

test('dirty files are listed BY NAME, not summarised as "not clean"', async () => {
  // A generic warning is the one people learn to click past.
  const { timers } = trackingTimers()
  const report = await checkFreshness({
    cwd: CWD,
    timers,
    git: fakeGit({ status: ' M src/a.ts\n?? new.ts\n', fetch: '', 'rev-list': '0\n' }),
  })
  assert.deepEqual(report.dirtyFiles, ['src/a.ts', 'new.ts'])
  assert.equal(isFresh(report), false)
  assert.match(describeFreshness(report), /2 uncommitted files: src\/a\.ts, new\.ts/)
})

test('a very dirty tree is capped, so one event does not carry a thousand names', async () => {
  const { timers } = trackingTimers()
  const status = Array.from({ length: 200 }, (_, i) => ` M file${i}.ts`).join('\n')
  const report = await checkFreshness({ cwd: CWD, timers, git: fakeGit({ status, fetch: '', 'rev-list': '0' }) })
  assert.equal(report.dirtyFiles.length, 20)
})

test('commits behind are counted and described, and are NOT a reason to stop: they are one to pull', async () => {
  const { timers } = trackingTimers()
  const report = await checkFreshness({
    cwd: CWD,
    timers,
    git: fakeGit({ status: '', fetch: '', 'rev-list': '3\n' }),
  })
  assert.equal(report.behind, 3)
  assert.equal(isFresh(report), true)
  assert.match(describeFreshness(report), /3 commits behind the remote/)
})

test('one commit behind is described in the singular', async () => {
  const { timers } = trackingTimers()
  const report = await checkFreshness({ cwd: CWD, timers, git: fakeGit({ status: '', fetch: '', 'rev-list': '1' }) })
  assert.match(describeFreshness(report), /1 commit behind/)
})

// ---------------------------------------------------------------------------
// It warns. It never blocks.
// ---------------------------------------------------------------------------

test('a FETCH THAT FAILS is not a reason to refuse to launch — it is a reason to say so', async () => {
  const { timers } = trackingTimers()
  const calls: string[] = []
  const report = await checkFreshness({
    cwd: CWD,
    timers,
    git: async (args) => {
      calls.push(args[0] ?? '')
      if (args[0] === 'fetch') throw new Error('fatal: could not read from remote repository')
      return args[0] === 'rev-list' ? '4' : ''
    },
  })
  assert.equal(report.fetchFailed, true)
  assert.equal(report.noUpstream, false)
  // No rev-list after a failed fetch: it would compare against a stale @{u}.
  assert.equal(calls.includes('rev-list'), false)
  assert.equal(report.behind, 0)
  assert.match(report.remoteWarning ?? '', /could not fetch: fatal: could not read from remote repository/)
  assert.equal(isFresh(report), true)
})

test('NO UPSTREAM is not a failure: noUpstream, never fetchFailed, and no warning (criterion 21b)', async () => {
  const { timers } = trackingTimers()
  const report = await checkFreshness({
    cwd: CWD,
    timers,
    git: fakeGit({ status: '', fetch: '', 'rev-list': new Error("fatal: no upstream configured for branch 'main'") }),
  })
  assert.equal(report.noUpstream, true)
  assert.equal(report.fetchFailed, false)
  assert.equal(report.remoteWarning, undefined)
  assert.equal(isFresh(report), true)
})

test('a pull error makes the report not fresh, and is described', () => {
  const report: FreshnessReport = { ...CLEAN, behind: 1, pullError: 'cannot-fast-forward: fatal: Not possible to fast-forward, aborting.' }
  assert.equal(isFresh(report), false)
  assert.match(describeFreshness(report), /cannot-fast-forward: fatal: Not possible/)
})

test('a rev-list that answers nonsense counts as zero behind rather than NaN', async () => {
  const { timers } = trackingTimers()
  const report = await checkFreshness({
    cwd: CWD,
    timers,
    git: fakeGit({ status: '', fetch: '', 'rev-list': 'not a number' }),
  })
  assert.equal(report.behind, 0)
})

test('not being able to read the working tree is reported, and is NOT reported as clean', async () => {
  const { timers } = trackingTimers()
  const report = await checkFreshness({
    cwd: CWD,
    timers,
    git: fakeGit({ status: new Error('fatal: not a git repository') }),
  })
  assert.equal(report.clean, false)
  assert.match(report.remoteWarning ?? '', /could not read the working tree/)
})

test('only the first line of a git error travels, not its whole output', async () => {
  const { timers } = trackingTimers()
  const report = await checkFreshness({
    cwd: CWD,
    timers,
    git: fakeGit({ status: new Error('fatal: bad\nstack line 1\nstack line 2') }),
  })
  assert.equal((report.remoteWarning ?? '').includes('stack line'), false)
})

// ---------------------------------------------------------------------------
// The timer is the INJECTED one, and it is disposed on every path
// ---------------------------------------------------------------------------

test('every bounding timer comes from ctx.timers and is disposed again', async () => {
  // The kernel owns what it hands out and disposes it when the module stops. A global
  // setTimeout armed in here would outlive that.
  const tracker = trackingTimers()
  await checkFreshness({
    cwd: CWD,
    timers: tracker.timers,
    git: fakeGit({ status: '', fetch: '', 'rev-list': '0' }),
  })
  assert.equal(tracker.armed > 0, true)
  assert.equal(tracker.disposed(), tracker.armed)
})

test('a git that never settles is bounded by the injected timer', async () => {
  const tracker = trackingTimers()
  const report = await checkFreshness({
    cwd: CWD,
    timers: {
      setInterval: tracker.timers.setInterval,
      // Fire immediately, standing in for the budget running out.
      setTimeout: (fn) => tracker.timers.setTimeout(fn, 0),
    },
    git: async () => await new Promise<string>(() => {}),
  })
  // The status read is the first to hang, and it is the one that says so.
  assert.match(report.remoteWarning ?? '', /did not finish within/)
})

test('a fetch that never settles is bounded too, and counts as a failed fetch', async () => {
  const tracker = trackingTimers()
  const report = await checkFreshness({
    cwd: CWD,
    timers: { setInterval: tracker.timers.setInterval, setTimeout: (fn) => tracker.timers.setTimeout(fn, 0) },
    git: async (args) => (args[0] === 'fetch' ? await new Promise<string>(() => {}) : ''),
  })
  assert.equal(report.fetchFailed, true)
  assert.match(report.remoteWarning ?? '', /git fetch did not finish within/)
})

test('describeFreshness says so plainly when there is nothing to say', () => {
  assert.equal(
    describeFreshness(CLEAN),
    'clean and up to date',
  )
})

test('a single dirty file is described in the singular', () => {
  assert.match(
    describeFreshness({ ...CLEAN, clean: false, dirtyFiles: ['a.ts'] }),
    /1 uncommitted file: a\.ts/,
  )
})

// ---------------------------------------------------------------------------
// pullIfSafe, with a script
// ---------------------------------------------------------------------------

test('pullIfSafe merges --ff-only @{u} INSIDE the sole section, and reports the commits', async () => {
  const { timers } = trackingTimers()
  const calls: string[][] = []
  let inside = false
  const outcome = await pullIfSafe({
    cwd: CWD,
    timers,
    behind: 2,
    git: async (args) => {
      assert.equal(inside, true, 'the merge runs inside the section')
      calls.push([...args])
      return ''
    },
    sole: async (fn) => {
      inside = true
      try {
        return await fn()
      } finally {
        inside = false
      }
    },
  })
  assert.deepEqual(outcome, { kind: 'pulled', commits: 2 })
  assert.deepEqual(calls, [['merge', '--ff-only', '@{u}']])
})

test('pullIfSafe with another holder in the project does not merge at all', async () => {
  const { timers } = trackingTimers()
  let merges = 0
  const outcome = await pullIfSafe({
    cwd: CWD,
    timers,
    behind: 1,
    git: async () => {
      merges += 1
      return ''
    },
    sole: async () => SOLE_SKIPPED,
  })
  assert.deepEqual(outcome, { kind: 'skipped' })
  assert.equal(merges, 0)
})

test('a merge that fails is a pullError with git’s reason, prefixed cannot-fast-forward', async () => {
  const { timers } = trackingTimers()
  const outcome = await pullIfSafe({
    cwd: CWD,
    timers,
    behind: 1,
    git: async () => {
      throw new Error('git merge failed (exit 128): fatal: Not possible to fast-forward, aborting.\nmore')
    },
    sole: alone,
  })
  assert.deepEqual(outcome, {
    kind: 'failed',
    pullError: 'cannot-fast-forward: git merge failed (exit 128): fatal: Not possible to fast-forward, aborting.',
  })
})

// ---------------------------------------------------------------------------
// Against real repositories and a bare remote
// ---------------------------------------------------------------------------

/** Real timers, unrefd, for the real-git tests. */
const realTimers = trackingTimers().timers

test('REAL: a clean site one commit behind is counted, then advances to @{u} (criterion 18)', async () => {
  const remote = await remoteWithClones()
  await pushFromOther(remote, 1)

  const report = await checkFreshness({ cwd: remote.site, timers: realTimers })
  assert.equal(report.clean, true)
  assert.equal(report.behind, 1)
  assert.equal(report.fetchFailed, false)
  assert.equal(report.noUpstream, false)

  const outcome = await pullIfSafe({ cwd: remote.site, timers: realTimers, behind: report.behind, sole: alone })
  assert.deepEqual(outcome, { kind: 'pulled', commits: 1 })
  assert.equal(await head(remote.site), await upstream(remote.site))
})

test('REAL: a diverged site gives a cannot-fast-forward pullError and NOTHING MOVES (criterion 19)', async () => {
  const remote = await remoteWithClones()
  await pushFromOther(remote, 1)
  await commitIn(remote.site, 'local.md', 'mine\n')
  const before = await head(remote.site)

  const report = await checkFreshness({ cwd: remote.site, timers: realTimers })
  assert.equal(report.behind, 1)
  const outcome = await pullIfSafe({ cwd: remote.site, timers: realTimers, behind: report.behind, sole: alone })

  assert.equal(outcome.kind, 'failed')
  assert.match(outcome.kind === 'failed' ? outcome.pullError : '', /^cannot-fast-forward: .*fatal:/)
  assert.equal(await head(remote.site), before)
  assert.equal(await git(remote.site, 'status', '--porcelain'), '')
})

test('REAL: a fetch to a remote that does not exist is fetchFailed, well within 30 s', async () => {
  const remote = await remoteWithClones()
  await git(remote.site, 'remote', 'set-url', 'origin', `${remote.home}/does-not-exist.git`)

  const started = Date.now()
  const report = await checkFreshness({ cwd: remote.site, timers: realTimers })
  assert.equal(Date.now() - started < 30_000, true)
  assert.equal(report.fetchFailed, true)
  assert.equal(report.noUpstream, false)
  assert.equal(report.behind, 0)
})

test('REAL: an ssh that waits for input fails the fetch within 30 s, and launches anyway (criterion 22)', async () => {
  const remote = await remoteWithClones()
  // Waits for git to speak while git waits for it: the shape of a prompt nobody will answer.
  const fake = `${remote.home}/fake-ssh.sh`
  await writeFile(fake, '#!/bin/sh\nread answer\nsleep 600\n')
  await chmod(fake, 0o755)
  await git(remote.site, 'remote', 'set-url', 'origin', 'ssh://factotum.invalid/repo.git')

  const started = Date.now()
  const report = await checkFreshness({
    cwd: remote.site,
    timers: realTimers,
    git: (args, timeoutMs, cwd) => runGit(args, timeoutMs, cwd, { ...process.env, GIT_SSH_COMMAND: fake }),
  })
  assert.equal(Date.now() - started < 30_000, true)
  assert.equal(report.fetchFailed, true)
  assert.equal(isFresh(report), true)
})

test('REAL: a repo with no upstream is noUpstream and NOT fetchFailed (criterion 21b)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'factotum-noup-'))
  await git(dir, 'init', '--quiet')
  await commitIn(dir, 'a.md', 'a\n')

  const report = await checkFreshness({ cwd: dir, timers: realTimers })
  assert.equal(report.noUpstream, true)
  assert.equal(report.fetchFailed, false)
  assert.equal(report.remoteWarning, undefined)
  assert.equal(isFresh(report), true)
})
