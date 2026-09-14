import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Timers } from '@factotum/core'
import { checkFreshness, describeFreshness, isFresh } from './freshness.ts'

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

test('a clean repo that is up to date is fresh', async () => {
  const { timers } = trackingTimers()
  const report = await checkFreshness({
    cwd: CWD,
    timers,
    git: fakeGit({ status: '', fetch: '', 'rev-list': '0\n' }),
  })
  assert.deepEqual(report, { clean: true, behind: 0, dirtyFiles: [], remoteWarning: undefined })
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

test('commits behind are counted and described', async () => {
  const { timers } = trackingTimers()
  const report = await checkFreshness({
    cwd: CWD,
    timers,
    git: fakeGit({ status: '', fetch: '', 'rev-list': '3\n' }),
  })
  assert.equal(report.behind, 3)
  assert.equal(isFresh(report), false)
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

test('NO REMOTE is not a reason to refuse to launch — it is a reason to say so', async () => {
  const { timers } = trackingTimers()
  const report = await checkFreshness({
    cwd: CWD,
    timers,
    git: fakeGit({ status: '', fetch: new Error("fatal: no upstream configured") }),
  })
  assert.equal(report.clean, true)
  assert.equal(report.behind, 0)
  assert.match(report.remoteWarning ?? '', /no upstream configured/)
  // Clean and not behind, so it still launches without asking.
  assert.equal(isFresh(report), true)
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
  assert.match(report.remoteWarning ?? '', /did not finish within/)
})

test('describeFreshness says so plainly when there is nothing to say', () => {
  assert.equal(
    describeFreshness({ clean: true, behind: 0, dirtyFiles: [], remoteWarning: undefined }),
    'clean and up to date',
  )
})

test('a single dirty file is described in the singular', () => {
  assert.match(
    describeFreshness({ clean: false, behind: 0, dirtyFiles: ['a.ts'], remoteWarning: undefined }),
    /1 uncommitted file: a\.ts/,
  )
})
