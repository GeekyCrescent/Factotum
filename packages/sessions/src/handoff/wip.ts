/**
 * The work in progress as git objects (spec 2026-10-07, D10): the working tree as a hash, the
 * commit that carries it, and — on the other side — applying it as uncommitted changes, checking
 * it would lose nothing first, and cleaning the source once it has gone.
 *
 * NOTHING HERE TOUCHES THE OWNER'S INDEX OR HEAD on the way out: the WIP is built on a temporary
 * index (`GIT_INDEX_FILE`) with plumbing, so a half-staged change stays half-staged.
 */

import { lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { handoffGit, handoffGitSucceeds } from './git.ts'

export interface TreeOptions {
  /** The temporary index: `<stateDir>/handoff/<hid>/<siteId>/index`. Removed when the call ends. */
  readonly indexFile: string
  /**
   * What the temporary index starts from (design D10, v4.2). `add -A` only consults the ignore
   * rules for what is NOT in the index, so on a host whose rules differ, seeding with the expected
   * tree is what lets a file this host ignores still be compared. The SOURCE uses HEAD; the target
   * never calls this without the tree it expects.
   */
  readonly seed?: string
  readonly base?: NodeJS.ProcessEnv
}

/** The working tree as a tree hash: `read-tree <seed>`, `add -A` (never `-f`), `write-tree`. */
export async function wipTree(repo: string, options: TreeOptions): Promise<string> {
  const git = (args: readonly string[]) => handoffGit(repo, args, { env: { GIT_INDEX_FILE: options.indexFile }, ...(options.base !== undefined ? { base: options.base } : {}) })
  try {
    await git(['read-tree', options.seed ?? 'HEAD'])
    await git(['add', '-A'])
    return (await git(['write-tree'])).trim()
  } finally {
    await rm(options.indexFile, { force: true })
  }
}

export interface WipOptions {
  readonly indexFile: string
  readonly hid: string
  /** This host's name, for the commit's message and identity. */
  readonly host: string
  readonly base?: NodeJS.ProcessEnv
}

export interface Wip {
  /** The source's HEAD when the WIP was taken. */
  readonly head: string
  /** The working tree: the WIP's tree, or HEAD's when there is nothing uncommitted. */
  readonly tree: string
  /** The WIP commit, child of `head`. `undefined` when the tree is HEAD's: nothing to carry. */
  readonly wip: string | undefined
}

/**
 * The WIP commit (design D10). Its identity and its signing never depend on the host's config: the
 * identity is factotum's own, and `commit.gpgSign=false` is in HANDOFF_GIT_CONFIG.
 */
export async function wipCommit(repo: string, options: WipOptions): Promise<Wip> {
  const base = options.base !== undefined ? { base: options.base } : {}
  const head = (await handoffGit(repo, ['rev-parse', 'HEAD'], base)).trim()
  const headTree = (await handoffGit(repo, ['rev-parse', 'HEAD^{tree}'], base)).trim()
  const tree = await wipTree(repo, { indexFile: options.indexFile, ...base })
  if (tree === headTree) return { head, tree, wip: undefined }
  const email = `factotum@${options.host}.invalid`
  const identity = { GIT_AUTHOR_NAME: 'factotum', GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'factotum', GIT_COMMITTER_EMAIL: email }
  const message = `factotum handoff ${options.hid} from ${options.host}`
  const wip = (await handoffGit(repo, ['commit-tree', tree, '-p', head, '-m', message], { env: identity, ...base })).trim()
  return { head, tree, wip }
}

const baseOf = (env: NodeJS.ProcessEnv | undefined) => (env !== undefined ? { base: env } : {})

/**
 * The WIP as uncommitted changes on the target (design D10), with plumbing, so `color.ui`,
 * `diff.noprefix` or `core.autocrlf` never matter:
 *
 *   read-tree -m -u HEAD <wip>    the index and the tree go from HEAD to the WIP
 *   update-index -q --refresh     a stale stat would make the next line see a change that is not one
 *   diff-files --quiet            the working tree IS the index, in everything the WIP touched
 *   reset -q                      the index back to HEAD: unstaged changes, the new files untracked
 *
 * THE CHECK IS BETWEEN `read-tree` AND `reset`, and it is not recomputed with `add -A`: under the
 * target's rules a WIP file ignored here would not enter, and give a false failure (v4.2). The
 * `write-tree` the design had is gone: right after `read-tree <wip>` the index IS the WIP, so it
 * could only ever agree (requirements §8, v4.3, «Para el implementador»).
 */
export async function applyWip(repo: string, wip: string, env?: NodeJS.ProcessEnv): Promise<'applied' | 'wip-apply-failed'> {
  const base = baseOf(env)
  try {
    await handoffGit(repo, ['read-tree', '-m', '-u', 'HEAD', wip], base)
  } catch {
    return 'wip-apply-failed'
  }
  // Exit 1 when an entry needed refreshing is not a failure: the refresh is what was asked.
  await handoffGit(repo, ['update-index', '-q', '--refresh'], base).catch(() => undefined)
  if (!(await handoffGitSucceeds(repo, ['diff-files', '--quiet'], base))) return 'wip-apply-failed'
  await handoffGit(repo, ['reset', '-q'], base)
  return 'applied'
}

/** Candidate paths per `status` call. A pathspec per candidate; the batch keeps a command line short. */
export const HANDOFF_PATHSPEC_BATCH = 500

export interface CollisionOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly batchSize?: number
  /** The seam a test counts `status` calls through. */
  readonly git?: (args: readonly string[]) => Promise<string>
}

/**
 * What the handoff would lose on the target BEFORE anything is touched (design D10, the v4.3 rule):
 * every path the handoff ADDS that already exists on disk in any form — file, folder or link — and
 * every folder on its way that exists and is NOT a folder, collides if `status --ignored` lists
 * anything of it. The tree was just checked clean, so all `status` can list there is ignored.
 *
 * `read-tree -m -u` overwrites, without a word, an untracked file the target ignores; and turns a
 * folder holding only ignored files into the WIP's file (measured, tasks §M, v4.3). `check-ignore`
 * cannot see the folder. Returns the colliding candidates, sorted: the path the handoff adds, or the
 * folder on its way — never each file underneath.
 */
export async function ignoredCollisions(repo: string, prevHead: string, final: string, options: CollisionOptions = {}): Promise<readonly string[]> {
  const git = options.git ?? ((args: readonly string[]) => handoffGit(repo, args, baseOf(options.env)))
  const added = (await git(['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--diff-filter=A', prevHead, final])).split('\0').filter((path) => path !== '')
  const candidates = await onDisk(repo, added)
  if (candidates.length === 0) return []

  const size = options.batchSize ?? HANDOFF_PATHSPEC_BATCH
  const colliding = new Set<string>()
  for (let start = 0; start < candidates.length; start += size) {
    const batch = candidates.slice(start, start + size)
    const listed = (await git(['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all', '--', ...batch.map((path) => `:(literal)${path}`)]))
      .split('\0')
      .filter((entry) => entry.length > 3)
      .map((entry) => entry.slice(3))
    for (const candidate of batch) {
      if (listed.some((path) => path === candidate || path.startsWith(`${candidate}/`))) colliding.add(candidate)
    }
  }
  return [...colliding].sort()
}

/** With `lstat` only: the added paths that exist, and the folders on their way that are not folders. */
async function onDisk(repo: string, added: readonly string[]): Promise<string[]> {
  const found = new Set<string>()
  const kind = async (path: string) => await lstat(join(repo, path)).catch(() => undefined)
  for (const path of added) {
    if ((await kind(path)) !== undefined) found.add(path)
    const segments = path.split('/')
    for (let depth = 1; depth < segments.length; depth += 1) {
      const folder = segments.slice(0, depth).join('/')
      const stat = await kind(folder)
      if (stat !== undefined && !stat.isDirectory()) found.add(folder)
    }
  }
  return [...found]
}

export interface CleanOptions {
  readonly hid: string
  /** The source's HEAD when the WIP was taken (step 6 of D9). */
  readonly head: string
  readonly wip: string | undefined
  /** The WIP's tree, or HEAD's when there was no WIP. */
  readonly tree: string
  readonly indexFile: string
  readonly env?: NodeJS.ProcessEnv
}

/**
 * The source, cleaned ONLY after the confirmation and ONLY if its tree and its HEAD are still the
 * ones that travelled (criterion 31, guardrail 4). Otherwise somebody — the owner, Obsidian, the
 * Git plugin — changed it during the handoff, and nothing is touched. The WIP is kept in
 * `refs/factotum/handoff-backup/<hid>` first. `clean` without `-x`: what git ignores stays.
 */
export async function cleanSource(repo: string, options: CleanOptions): Promise<'cleaned' | 'source-changed-during-handoff'> {
  const base = baseOf(options.env)
  if ((await handoffGit(repo, ['rev-parse', 'HEAD'], base)).trim() !== options.head) return 'source-changed-during-handoff'
  const now = await wipTree(repo, { indexFile: options.indexFile, ...base })
  if (now !== options.tree) return 'source-changed-during-handoff'
  if (options.wip !== undefined) await handoffGit(repo, ['update-ref', `refs/factotum/handoff-backup/${options.hid}`, options.wip], base)
  await handoffGit(repo, ['reset', '-q', '--hard', 'HEAD'], base)
  await handoffGit(repo, ['clean', '-q', '-fd'], base)
  return 'cleaned'
}
