/**
 * Real repositories for the handoff's git tests (spec 2026-10-07, G). Not doubles: only a real git
 * proves that a tree hash is the same on both sides, or that an ignored file survived.
 *
 * Every repo here runs with an EMPTY global config and no system config, so the machine running the
 * tests — its `~/.config/git/ignore`, its signing, its identity — never leaks into a result.
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface World {
  readonly home: string
  /** The environment every git of the test runs with, `handoff*` functions included (`base`). */
  readonly env: NodeJS.ProcessEnv
  readonly bare: string
  /** The origin host's clone. */
  readonly source: string
  /** The target host's clone. */
  readonly target: string
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'owner',
  GIT_AUTHOR_EMAIL: 'owner@factotum.invalid',
  GIT_COMMITTER_NAME: 'owner',
  GIT_COMMITTER_EMAIL: 'owner@factotum.invalid',
}

/** git as the OWNER: with an identity, so the test's own commits work on any machine. */
export async function sh(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, env: { ...env, ...IDENTITY }, maxBuffer: 64 * 1024 * 1024 })
  return stdout.trim()
}

export async function put(dir: string, file: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(join(dir, file)), { recursive: true })
  await writeFile(join(dir, file), content)
}

export async function commitAll(env: NodeJS.ProcessEnv, dir: string, message = 'change'): Promise<string> {
  await sh(env, dir, 'add', '-A')
  await sh(env, dir, 'commit', '--quiet', '-m', message)
  return await sh(env, dir, 'rev-parse', 'HEAD')
}

/** A bare remote with one commit (`a.txt`), cloned as the source and as the target. */
export async function world(): Promise<World> {
  const home = await mkdtemp(join(tmpdir(), 'factotum-handoff-git-'))
  const globalConfig = join(home, 'gitconfig')
  await writeFile(globalConfig, '')
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'xdg'),
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const bare = join(home, 'remote.git')
  const seed = join(home, 'seed')
  await execFileP('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare], { env })
  await execFileP('git', ['init', '--quiet', '--initial-branch=main', seed], { env })
  await put(seed, 'a.txt', 'a\n')
  await commitAll(env, seed, 'base')
  await sh(env, seed, 'remote', 'add', 'origin', bare)
  await sh(env, seed, 'push', '--quiet', '-u', 'origin', 'main')
  const source = join(home, 'source')
  const target = join(home, 'target')
  await execFileP('git', ['clone', '--quiet', bare, source], { env })
  await execFileP('git', ['clone', '--quiet', bare, target], { env })
  return { home, env, bare, source, target }
}

/** Where a test's temporary index lives: outside the repo, as `<stateDir>/handoff/<hid>/<siteId>/index` is. */
export async function indexPath(w: World, name = 'index'): Promise<string> {
  const dir = await mkdtemp(join(w.home, 'state-'))
  return join(dir, name)
}

/** Moves `commit` from one clone to another without a remote: what a bundle would do, for tests of other steps. */
export async function carry(w: World, from: string, to: string, commit: string): Promise<void> {
  await sh(w.env, from, 'update-ref', 'refs/test/carry', commit)
  await sh(w.env, to, 'fetch', '--quiet', from, 'refs/test/carry:refs/test/carry')
  await sh(w.env, from, 'update-ref', '-d', 'refs/test/carry')
}
