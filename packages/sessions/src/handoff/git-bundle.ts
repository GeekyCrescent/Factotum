/**
 * THE CODE TRAVELS IN A `git bundle`, daemon to daemon, NEVER THROUGH THE REMOTE (spec 2026-10-07,
 * D8 and D10; the owner's decision of 2026-10-14). The bundle carries the branch's local commits the
 * remote does not have, and the WIP. Nothing here pushes: the remote is only read, by a `fetch`, when
 * the target lacks a base.
 *
 * Measured with git 2.54 (tasks §M, v4): `bundle create` needs REFS, not bare hashes, so two
 * temporary refs live for the length of the command; a ref the bases already cover does not enter;
 * with everything covered `bundle create` refuses, so the commits are counted first.
 */

import { handoffGit, handoffGitSucceeds } from './git.ts'

/** The handoff's temporary refs on the source, and its imported refs on the target. */
export const handoffRefPrefix = (hid: string): string => `refs/factotum/handoff/${hid}`

/**
 * What the bundle does NOT carry, because the target has it or can fetch it (design D10):
 * `^<branchHead>` when the target has the branch (already checked to be an ancestor: target-ahead),
 * and everything the source knows to be on the remote, after its fetch.
 */
export function handoffBase(branchHead: string | undefined): readonly string[] {
  return [...(branchHead === undefined ? [] : [`^${branchHead}`]), '--not', '--remotes=origin']
}

export interface MakeBundleOptions {
  readonly hid: string
  readonly head: string
  readonly wip: string | undefined
  readonly base: readonly string[]
  /** `<stateDir>/handoff/<hid>/<siteId>/code.bundle`. */
  readonly out: string
  readonly env?: NodeJS.ProcessEnv
}

/** The source's bundle, or `undefined` when there is nothing to carry. Its temporary refs never outlive it. */
export async function makeBundle(repo: string, options: MakeBundleOptions): Promise<string | undefined> {
  const base = options.env !== undefined ? { base: options.env } : {}
  const tips = [options.head, ...(options.wip === undefined ? [] : [options.wip])]
  const count = Number.parseInt((await handoffGit(repo, ['rev-list', '--count', ...tips, ...options.base], base)).trim(), 10)
  if (count === 0) return undefined

  const prefix = handoffRefPrefix(options.hid)
  const refs = [`${prefix}/head`, ...(options.wip === undefined ? [] : [`${prefix}/wip`])]
  try {
    await handoffGit(repo, ['update-ref', `${prefix}/head`, options.head], base)
    if (options.wip !== undefined) await handoffGit(repo, ['update-ref', `${prefix}/wip`, options.wip], base)
    await handoffGit(repo, ['bundle', 'create', options.out, ...refs, ...options.base], base)
    return options.out
  } finally {
    for (const ref of refs) await handoffGit(repo, ['update-ref', '-d', ref], base).catch(() => undefined)
  }
}

/** What the target has: everything already, everything after one `fetch origin`, or not enough. */
export type BaseCheck = 'present' | 'fetched' | 'missing'

/**
 * That the target has what the `commit` will need (design D10): a bundle's prerequisites or, with
 * no bundle, the source's HEAD. One rule for both: check, `fetch origin` once if missing, check
 * again. The fetch writes `refs/remotes` only, never the tree; a fetch that fails is just a check
 * that fails again.
 */
export async function ensureBase(repo: string, what: { readonly bundle: string } | { readonly head: string }, env?: NodeJS.ProcessEnv): Promise<BaseCheck> {
  const base = env !== undefined ? { base: env } : {}
  const check = () =>
    'bundle' in what
      ? handoffGitSucceeds(repo, ['bundle', 'verify', '-q', what.bundle], base)
      : handoffGitSucceeds(repo, ['cat-file', '-e', `${what.head}^{commit}`], base)
  if (await check()) return 'present'
  await handoffGit(repo, ['fetch', '--quiet', 'origin'], base).catch(() => undefined)
  return (await check()) ? 'fetched' : 'missing'
}

/** The bundle into `refs/factotum/handoff/<hid>/*` of the target. Refs only: the tree is not touched. */
export async function importBundle(repo: string, options: { readonly bundle: string; readonly hid: string; readonly env?: NodeJS.ProcessEnv }): Promise<void> {
  const prefix = handoffRefPrefix(options.hid)
  // The peer's objects are checked as they come in (security review); `fetch origin` is not, so an old
  // repo's historic warnings never stop the pull of its own remote.
  const fsck = [['fetch.fsckObjects', 'true'], ['transfer.fsckObjects', 'true']] as const
  await handoffGit(repo, ['fetch', '--quiet', options.bundle, `${prefix}/*:${prefix}/*`], { config: fsck, ...(options.env !== undefined ? { base: options.env } : {}) })
}
