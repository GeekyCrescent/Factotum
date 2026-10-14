/**
 * The target's undo (spec 2026-10-07, D10, `restoreTarget`). IT SAVES BEFORE IT ERASES: anything
 * in the tree that is not the handoff's own goes to `refs/factotum/handoff-rescue/<hid>` before any
 * `reset --hard` (guardrails 4 and 5). Everything it needs comes from the journal (D11).
 *
 *   1. which tree is on disk? The trees the handoff could have stopped at with nobody else touching
 *      anything — the WIP's, `head`'s, `branchHead`'s, `prevHead`'s — each measured WITH ITS OWN
 *      SEED (v4.2), so a file this host ignores does not make a false rescue. None of them: somebody
 *      edited during the handoff, and that tree is saved;
 *   2. `read-tree <m>`, then `reset --hard HEAD` and `clean -fd`: with `m` in the index, a file the
 *      WIP brought and this host ignores is TRACKED, so `reset --hard` takes it — `clean` without
 *      `-x` would have left it (measured, tasks §M, v4.2);
 *   3. back to `prevBranch` (or `--detach <prevHead>`), now that the tree is clean, with
 *      `--no-overwrite-ignore` like every checkout of the handoff: an ignored file of the owner in
 *      the way fails the undo (`abort-failed`) rather than being overwritten (tasks §M, G8);
 *   4. `reset --hard <prevHead>`;
 *   5. the handoff's branch, if it is not `prevBranch`: deleted if the handoff created it, or back to
 *      `branchHead` — the `merge --ff-only` had moved it to `head`.
 */

import { handoffGit, handoffGitSucceeds } from './git.ts'
import { wipTree } from './wip.ts'

export interface RestoreOptions {
  readonly hid: string
  readonly branch: string
  /** `undefined` when the target was on a detached HEAD at `prepare`. */
  readonly prevBranch: string | undefined
  readonly prevHead: string
  /** The tip of `refs/heads/<branch>` at `prepare`, when the branch existed. */
  readonly branchHead: string | undefined
  /** Written BEFORE the `checkout -b`: the branch may or may not exist. */
  readonly branchCreated: boolean
  readonly head: string
  readonly wip: string | undefined
  readonly indexFile: string
  readonly env?: NodeJS.ProcessEnv
}

export const rescueRef = (hid: string): string => `refs/factotum/handoff-rescue/${hid}`

export async function restoreTarget(repo: string, options: RestoreOptions): Promise<{ readonly rescued: boolean }> {
  const base = options.env !== undefined ? { base: options.env } : {}
  const git = (...args: string[]) => handoffGit(repo, args, base)

  // 1. Which of the expected trees is on disk, each with its own seed.
  const expected = await treesOf(repo, [options.wip, options.head, options.branchHead, options.prevHead], base)
  let onDisk: string | undefined
  for (const tree of expected) {
    if ((await wipTree(repo, { indexFile: options.indexFile, seed: tree, ...base })) === tree) {
      onDisk = tree
      break
    }
  }
  let rescued = false
  if (onDisk === undefined) {
    onDisk = await wipTree(repo, { indexFile: options.indexFile, seed: expected[0] ?? 'HEAD', ...base })
    const identity = { GIT_AUTHOR_NAME: 'factotum', GIT_AUTHOR_EMAIL: 'factotum@rescue.invalid', GIT_COMMITTER_NAME: 'factotum', GIT_COMMITTER_EMAIL: 'factotum@rescue.invalid' }
    const message = `factotum handoff ${options.hid}: changes found on this host during the handoff`
    const commit = (await handoffGit(repo, ['commit-tree', onDisk, '-p', 'HEAD', '-m', message], { env: identity, ...base })).trim()
    await git('update-ref', rescueRef(options.hid), commit)
    rescued = true
  }

  // 2. Clean on the handoff's branch.
  await git('read-tree', onDisk)
  await git('reset', '-q', '--hard', 'HEAD')
  await git('clean', '-q', '-fd')

  // 3 and 4. Back where prepare found it.
  if (options.prevBranch === undefined) await git('checkout', '-q', '--no-overwrite-ignore', '--detach', options.prevHead)
  else await git('checkout', '-q', '--no-overwrite-ignore', options.prevBranch, '--')
  await git('reset', '-q', '--hard', options.prevHead)

  // 5. The handoff's branch, when it is another one.
  if (options.branch !== options.prevBranch) {
    const ref = `refs/heads/${options.branch}`
    if (options.branchCreated) {
      // Only the branch the handoff made: at `head`. One the owner made meanwhile is theirs (security review).
      const tip = await handoffGit(repo, ['rev-parse', '--verify', '-q', ref], base).then((out) => out.trim(), () => undefined)
      if (tip !== undefined && tip === options.head) await git('branch', '-D', options.branch)
    } else if (options.branchHead !== undefined) {
      await git('update-ref', ref, options.branchHead)
    }
  }
  return { rescued }
}

/** The tree of each commit, in order, skipping the absent ones and the ones this repo lacks. */
async function treesOf(repo: string, commits: readonly (string | undefined)[], base: { readonly base?: NodeJS.ProcessEnv }): Promise<string[]> {
  const trees: string[] = []
  for (const commit of commits) {
    if (commit === undefined) continue
    const tree = await handoffGit(repo, ['rev-parse', '--verify', '-q', `${commit}^{tree}`], base).then((out) => out.trim(), () => undefined)
    if (tree !== undefined && !trees.includes(tree)) trees.push(tree)
  }
  return trees
}
