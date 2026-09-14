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
 */

import { execFile } from 'node:child_process'
import type { Timers } from '@factotum/core'
import type { FreshnessReport } from './types.ts'

/** Long enough for a `git fetch` over a slow link, short enough not to be a hang. */
export const FETCH_TIMEOUT_MS = 8_000
const STATUS_TIMEOUT_MS = 5_000
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
  readonly git?: (args: readonly string[], timeoutMs: number, cwd: string) => Promise<string>
}

function runGit(args: readonly string[], timeoutMs: number, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
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
  let remoteWarning: string | undefined

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
      clean: false,
      behind: 0,
      dirtyFiles: [],
      remoteWarning: `could not read the working tree: ${message(error)}`,
    }
  }

  let behind = 0
  try {
    await within(git(['fetch', '--quiet'], FETCH_TIMEOUT_MS, deps.cwd), FETCH_TIMEOUT_MS, deps.timers, 'git fetch')
    const count = await within(
      git(['rev-list', '--count', 'HEAD..@{u}'], STATUS_TIMEOUT_MS, deps.cwd),
      STATUS_TIMEOUT_MS,
      deps.timers,
      'git rev-list',
    )
    const parsed = Number.parseInt(count.trim(), 10)
    behind = Number.isNaN(parsed) ? 0 : parsed
  } catch (error) {
    // No remote, no upstream, no network, or a fetch that asked for a password. All
    // of them mean the same thing here: cannot compare, carry on.
    remoteWarning = `could not compare against the remote: ${message(error)}`
  }

  return {
    clean: dirtyFiles.length === 0,
    behind,
    dirtyFiles: dirtyFiles.slice(0, MAX_DIRTY_LISTED),
    remoteWarning,
  }
}

/** Fresh enough to launch without asking. */
export function isFresh(report: FreshnessReport): boolean {
  return report.clean && report.behind === 0
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
  return parts.length === 0 ? 'clean and up to date' : parts.join('; ')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? error.name : String(error)
}
