/**
 * The work in progress as git objects (spec 2026-10-07, D10): the working tree as a hash, the
 * commit that carries it, and — on the other side — applying it as uncommitted changes, checking
 * it would lose nothing first, and cleaning the source once it has gone.
 *
 * NOTHING HERE TOUCHES THE OWNER'S INDEX OR HEAD on the way out: the WIP is built on a temporary
 * index (`GIT_INDEX_FILE`) with plumbing, so a half-staged change stays half-staged.
 */

import { rm } from 'node:fs/promises'
import { handoffGit } from './git.ts'

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
