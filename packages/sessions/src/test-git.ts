/**
 * Real repositories for the tests of the pull before launching (spec 2026-10-07-dos-hosts, D5): a
 * bare remote, the site that tracks it, and a second clone that plays the other host pushing.
 *
 * Not a double: a fake git proves the order of the calls, and only a real one proves that
 * `merge --ff-only @{u}` moved HEAD — or that it did not.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** Commits made here need an author, and a test machine may have none configured. */
const IDENTITY = {
  GIT_AUTHOR_NAME: 'factotum-test',
  GIT_AUTHOR_EMAIL: 'test@factotum.invalid',
  GIT_COMMITTER_NAME: 'factotum-test',
  GIT_COMMITTER_EMAIL: 'test@factotum.invalid',
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, env: { ...process.env, ...IDENTITY } })
  return stdout.trim()
}

export async function commitIn(dir: string, file: string, content: string): Promise<void> {
  await writeFile(join(dir, file), content)
  await git(dir, 'add', file)
  await git(dir, 'commit', '--quiet', '-m', `change ${file}`)
}

export interface Remote {
  readonly home: string
  readonly bare: string
  /** The site: a clone of `bare`, tracking `origin/main`. */
  readonly site: string
  /** Another clone of `bare`: what the other host pushes from. */
  readonly other: string
}

/** A bare remote with one commit, and two clones of it. Under `home` when given. */
export async function remoteWithClones(home?: string): Promise<Remote> {
  const root = home ?? (await mkdtemp(join(tmpdir(), 'factotum-remote-')))
  const bare = join(root, 'remote.git')
  const seed = join(root, 'seed')
  await execFileP('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare])
  await execFileP('git', ['init', '--quiet', '--initial-branch=main', seed])
  await commitIn(seed, 'README.md', 'one\n')
  await git(seed, 'remote', 'add', 'origin', bare)
  await git(seed, 'push', '--quiet', '-u', 'origin', 'main')

  const site = join(root, 'site')
  const other = join(root, 'other')
  await execFileP('git', ['clone', '--quiet', bare, site])
  await execFileP('git', ['clone', '--quiet', bare, other])
  return { home: root, bare, site, other }
}

/** The other host pushes `count` commits: the site is now that many behind, once it fetches. */
export async function pushFromOther(remote: Remote, count = 1): Promise<void> {
  for (let i = 0; i < count; i += 1) await commitIn(remote.other, `other-${Date.now()}-${i}.md`, `${i}\n`)
  await git(remote.other, 'push', '--quiet')
}

export const head = (dir: string): Promise<string> => git(dir, 'rev-parse', 'HEAD')
export const upstream = (dir: string): Promise<string> => git(dir, 'rev-parse', '@{u}')
