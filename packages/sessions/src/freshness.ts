/**
 * Is this repository clean, and is it up to date?
 *
 * IT WARNS. IT NEVER BLOCKS, AND IT NEVER GOES QUIET. Those are three separate
 * promises:
 *
 *   - a site that is not a git repository is not checked at all;
 *   - no remote, or no network, is not a reason to refuse to launch — it is a reason
 *     to say so and carry on;
 *   - the report says WHAT was found — how many commits behind, which files are dirty
 *     — and not a generic "the repo is not clean", because the generic version is the
 *     one people learn to click past.
 *
 * AND BEHIND IS A REASON TO PULL, NOT TO STOP (spec 2026-10-07-dos-hosts, D5). `pullIfSafe`
 * fast-forwards a clean tree to `@{u}` — never a merge commit, never a rebase — and only when
 * this launch is the project's sole holder. What stops a launch is a dirty tree, or a
 * fast-forward that could not be made: `isFresh` is read AFTER the pull.
 */

import type { Timers } from '@factotum/core'
import {
  FETCH_TIMEOUT_MS,
  GIT_LOCAL_TIMEOUT_MS as STATUS_TIMEOUT_MS,
  GIT_MERGE_TIMEOUT_MS,
  runGit,
  type GitRunner,
} from './git.ts'
import { SOLE_SKIPPED, type SoleSkipped } from './locks.ts'
import type { FreshnessReport } from './types.ts'

export { FETCH_TIMEOUT_MS }
/** A dirty tree with a thousand files does not need a thousand names in an event. */
const MAX_DIRTY_LISTED = 20

export interface FreshnessDeps {
  readonly cwd: string
  /**
   * `ctx.timers`, not the global.
   *
   * The kernel owns every timer it hands out and disposes them when the module is
   * disabled. A global `setTimeout` armed in here would outlive that, which is the
   * rule in CLAUDE.md §6 and the reason `timers` crosses in `EngineSetup` at all.
   */
  readonly timers: Timers
  /** A seam for tests, so nothing here needs a real repository over a real network. */
  readonly git?: GitRunner
}

/**
 * Bounded by an INJECTED timer.
 *
 * `execFile`'s own `timeout` covers a process that runs too long; this covers the
 * promise never settling at all. The timer is disposed on every path, so a fast answer
 * does not leave one armed.
 */
async function within<T>(work: Promise<T>, ms: number, timers: Timers, what: string): Promise<T> {
  let timer: Disposable | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = timers.setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms)
      }),
    ])
  } finally {
    timer?.[Symbol.dispose]()
  }
}

export async function checkFreshness(deps: FreshnessDeps): Promise<FreshnessReport> {
  const git = deps.git ?? runGit
  const dirtyFiles: string[] = []

  try {
    const status = await within(
      git(['status', '--porcelain'], STATUS_TIMEOUT_MS, deps.cwd),
      STATUS_TIMEOUT_MS,
      deps.timers,
      'git status',
    )
    for (const line of status.split('\n')) {
      const name = line.slice(3).trim()
      if (name !== '') dirtyFiles.push(name)
    }
  } catch (error) {
    // Not being able to ask is not the same as being clean, and saying so beats
    // claiming either.
    return {
      ...NOTHING_COMPARED,
      clean: false,
      remoteWarning: `could not read the working tree: ${message(error)}`,
    }
  }

  const tree = { clean: dirtyFiles.length === 0, dirtyFiles: dirtyFiles.slice(0, MAX_DIRTY_LISTED) }

  // TWO TRIES, NOT ONE. Measured (audit v2): with no remote, `fetch` exits 0 and `rev-list …@{u}`
  // exits 128. One try made "no network" and "nothing to compare against" the same warning.
  try {
    await within(git(['fetch', '--quiet'], FETCH_TIMEOUT_MS, deps.cwd), FETCH_TIMEOUT_MS, deps.timers, 'git fetch')
  } catch (error) {
    // No network, or a credential that would have asked. NO rev-list: it would count against
    // whatever @{u} the last fetch left, and call that the truth.
    return { ...NOTHING_COMPARED, ...tree, fetchFailed: true, remoteWarning: `could not fetch: ${message(error)}` }
  }

  try {
    const count = await within(
      git(['rev-list', '--count', 'HEAD..@{u}'], STATUS_TIMEOUT_MS, deps.cwd),
      STATUS_TIMEOUT_MS,
      deps.timers,
      'git rev-list',
    )
    const parsed = Number.parseInt(count.trim(), 10)
    return { ...NOTHING_COMPARED, ...tree, behind: Number.isNaN(parsed) ? 0 : parsed }
  } catch {
    // The fetch worked, so there is no upstream to count against. A branch nobody pushes is
    // a choice, not a failure: no warning.
    return { ...NOTHING_COMPARED, ...tree, noUpstream: true }
  }
}

/** The report before anything was found. Spread first, so each path names only what it found. */
const NOTHING_COMPARED: FreshnessReport = {
  clean: true,
  behind: 0,
  dirtyFiles: [],
  remoteWarning: undefined,
  fetchFailed: false,
  noUpstream: false,
  pullError: undefined,
}

export type PullOutcome =
  | { readonly kind: 'pulled'; readonly commits: number }
  /** Another holder was in the project when the section came round: nothing was touched. */
  | { readonly kind: 'skipped' }
  | { readonly kind: 'failed'; readonly pullError: string }

export interface PullDeps extends FreshnessDeps {
  /** What `checkFreshness` counted. The merge goes to that same `@{u}`, so it is what moved. */
  readonly behind: number
  /**
   * `SiteLocks.soleSection` with the site and this launch's holder bound: runs `fn` inside the
   * site's queue only if this launch is its sole holder, and keeps every `acquire` out meanwhile.
   */
  readonly sole: <T>(fn: () => Promise<T>) => Promise<T | SoleSkipped>
}

/**
 * Fast-forwards to `@{u}`. ONLY on a clean tree, which the caller has checked: on a clean tree
 * `merge --ff-only` fails only by divergence, and then it moves nothing.
 *
 * Never throws: a failure is a `pullError`, which the launch shows as `stale` (criterion 19).
 */
export async function pullIfSafe(deps: PullDeps): Promise<PullOutcome> {
  const git = deps.git ?? runGit
  try {
    const ran = await deps.sole(async () => {
      await within(
        git(['merge', '--ff-only', '@{u}'], GIT_MERGE_TIMEOUT_MS, deps.cwd),
        GIT_MERGE_TIMEOUT_MS,
        deps.timers,
        'git merge',
      )
      return 'merged' as const
    })
    return ran === SOLE_SKIPPED ? { kind: 'skipped' } : { kind: 'pulled', commits: deps.behind }
  } catch (error) {
    return { kind: 'failed', pullError: `cannot-fast-forward: ${message(error)}` }
  }
}

/**
 * Fresh enough to launch without asking: a clean tree, and no fast-forward that failed.
 *
 * Behind is NOT in it any more: it is a reason to pull, and the launch reads this after the pull.
 */
export function isFresh(report: FreshnessReport): boolean {
  return report.clean && report.pullError === undefined
}

/** What the owner reads. Says what was found, never just that something was. */
export function describeFreshness(report: FreshnessReport): string {
  const parts: string[] = []
  if (report.behind > 0) parts.push(`${report.behind} commit${report.behind === 1 ? '' : 's'} behind the remote`)
  if (!report.clean) {
    const names = report.dirtyFiles.join(', ')
    parts.push(`${report.dirtyFiles.length} uncommitted file${report.dirtyFiles.length === 1 ? '' : 's'}: ${names}`)
  }
  if (report.remoteWarning !== undefined) parts.push(report.remoteWarning)
  if (report.pullError !== undefined) parts.push(report.pullError)
  return parts.length === 0 ? 'clean and up to date' : parts.join('; ')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? error.name : String(error)
}
