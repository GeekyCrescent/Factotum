/**
 * How the handoff runs git (spec 2026-10-07-dos-hosts, D10). ONE DOOR: every git command of the
 * handoff, on either host, goes through `handoffGit`, which adds two things to `runGit`'s rules:
 *
 * - NO HOOKS AND NO MAINTENANCE (guardrail 13). A `post-checkout`, a `post-merge`, a
 *   `reference-transaction` or a `gc --auto` would run code inside the budget and do things the
 *   undo does not know about. The config travels IN THE ENVIRONMENT (`GIT_CONFIG_COUNT`), never as
 *   `-c`: `runGit` tells a network command by `args[0]`, and with `-c` in front a `fetch` would stop
 *   reading the repo's `core.sshCommand` first;
 * - ONE TIMEOUT TABLE (D10, «Timeouts»), 60 s by default: a command missing from the table must not
 *   fall to the 5 s that the vault and the BWR repos do not fit in.
 *
 * `GIT_OPTIONAL_LOCKS=0` rides along: `status` takes `index.lock` to refresh the index, and a
 * read of the owner's repo must never be the thing that makes their own git fail (requirements §8,
 * v4.3, «Para el implementador»).
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { GIT_LOCAL_TIMEOUT_MS, GIT_NET_TIMEOUT_MS, GitError, runGit } from '../git.ts'

/** Everything that reads or writes the tree, the index or many objects (design D10). */
export const GIT_HANDOFF_TIMEOUT_MS = 60_000

/**
 * No hooks, no maintenance, no signing and no fsmonitor, for every git command of the handoff.
 * `core.fsmonitor` is not in the design's list: it names a program git runs on `status`, which is
 * a hook by another name (security review of corte 1, finding 6).
 */
export const HANDOFF_GIT_CONFIG: readonly (readonly [string, string])[] = [
  ['core.hooksPath', '/dev/null'],
  ['maintenance.auto', 'false'],
  ['gc.auto', '0'],
  ['commit.gpgSign', 'false'],
  ['core.fsmonitor', 'false'],
  // A checkout or a merge never walks into submodules the peer's commits may name (security review).
  ['submodule.recurse', 'false'],
]

/** Only what reads or writes a ref. Everything else gets GIT_HANDOFF_TIMEOUT_MS. */
const LOCAL_COMMANDS = new Set(['rev-parse', 'update-ref', 'branch', 'merge-base', 'cat-file', 'for-each-ref', 'config', 'symbolic-ref'])

/** The timeout of one handoff command, by the table of design D10. */
export function handoffTimeoutMs(args: readonly string[]): number {
  const command = args[0] ?? ''
  if (LOCAL_COMMANDS.has(command)) return GIT_LOCAL_TIMEOUT_MS
  // `fetch origin` is the network; `fetch <bundle>` reads a file here, and is heavy.
  if (command === 'fetch' && args.slice(1).find((arg) => !arg.startsWith('-')) === 'origin') return GIT_NET_TIMEOUT_MS
  return GIT_HANDOFF_TIMEOUT_MS
}

/** The environment of a handoff command: `base`, plus the config, appended to any already there. A NEW object. */
export function handoffEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const start = Number.parseInt(base['GIT_CONFIG_COUNT'] ?? '0', 10) || 0
  const config = Object.fromEntries(
    HANDOFF_GIT_CONFIG.flatMap(([key, value], i) => [
      [`GIT_CONFIG_KEY_${start + i}`, key],
      [`GIT_CONFIG_VALUE_${start + i}`, value],
    ]),
  )
  return { ...base, ...config, GIT_CONFIG_COUNT: String(start + HANDOFF_GIT_CONFIG.length), GIT_OPTIONAL_LOCKS: '0', ...extra }
}

export interface HandoffGitOptions {
  /** Extra variables: `GIT_INDEX_FILE` for a temporary index, an identity for `commit-tree`. */
  readonly env?: Record<string, string>
  /** Config for THIS command only, by the environment like the rest: the bundle's fsck. */
  readonly config?: readonly (readonly [string, string])[]
  /** Tests point it at a fake home; production uses the process's. */
  readonly base?: NodeJS.ProcessEnv
}

/** THE door: one handoff git command, its stdout, or a `GitError`. */
export async function handoffGit(repo: string, args: readonly string[], options: HandoffGitOptions = {}): Promise<string> {
  const base = handoffEnv(options.base)
  const start = Number.parseInt(base['GIT_CONFIG_COUNT'] ?? '0', 10)
  const extra = Object.fromEntries(
    (options.config ?? []).flatMap(([key, value], i) => [
      [`GIT_CONFIG_KEY_${start + i}`, key],
      [`GIT_CONFIG_VALUE_${start + i}`, value],
    ]),
  )
  const count = options.config === undefined ? {} : { GIT_CONFIG_COUNT: String(start + options.config.length) }
  return await runGit(args, handoffTimeoutMs(args), repo, { ...base, ...extra, ...count, ...options.env })
}

/**
 * A command whose EXIT CODE is the answer (`cat-file -e`, `diff-files --quiet`, `merge-base
 * --is-ancestor`, `bundle verify`): `true` on 0, `false` on any other exit. A timeout or a git that
 * would not start still throws — "I do not know" is never a "no".
 */
export async function handoffGitSucceeds(repo: string, args: readonly string[], options: HandoffGitOptions = {}): Promise<boolean> {
  try {
    await handoffGit(repo, args, options)
    return true
  } catch (error) {
    if (error instanceof GitError && !error.timedOut && error.exitCode !== undefined) return false
    throw error
  }
}

/**
 * `origin` as a key two hosts can compare (design D7, S2): `git@host:a/b.git`, `ssh://git@host/a/b`,
 * `ssh://git@host:22/a/b.git` and `https://host/a/b` are all `host/a/b`, ALL IN LOWER CASE — GitHub
 * and GitLab do not tell case apart in the path, and a clash that comes from it is an
 * `ambiguous-remote`, never a wrong pairing. A local path (the tests' bare remotes) stays a path.
 */
export function remoteKey(url: string): string | undefined {
  const trimmed = url.trim()
  if (trimmed === '') return undefined
  const strip = (path: string) => path.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  const scp = /^[^/@:]+@([^/:]+):(.+)$/.exec(trimmed)
  if (scp !== null) return `${scp[1]}/${strip(scp[2] ?? '').replace(/^\/+/, '')}`.toLowerCase()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      if (parsed.protocol === 'file:') return strip(decodeURIComponent(parsed.pathname)).toLowerCase()
      return `${parsed.hostname}/${strip(decodeURIComponent(parsed.pathname)).replace(/^\/+/, '')}`.toLowerCase()
    } catch {
      return undefined
    }
  }
  return strip(trimmed).toLowerCase()
}

/** The digest of one ignore file: `none` when it does not exist or holds no rule. */
export type IgnoreFileDigest = string

export interface IgnoreDigest {
  /** `core.excludesFile`, or `$XDG_CONFIG_HOME/git/ignore`, or `~/.config/git/ignore`. */
  readonly global: IgnoreFileDigest
  /** `$(git rev-parse --git-path info/exclude)`. */
  readonly info: IgnoreFileDigest
}

/**
 * The hashes of the ignore rules that do NOT travel with the repo (design D10). Two hosts whose
 * digests differ may refuse a handoff one way (`target-ignored-collision`) and the other way
 * forever (`target-dirty`): the preview warns, `doctor` compares. Comments and blank lines do not
 * count — so `git init`'s template does not — and the order does.
 */
export async function ignoreDigest(repo: string, base: NodeJS.ProcessEnv = process.env): Promise<IgnoreDigest> {
  const options = { base }
  const configured = await handoffGit(repo, ['config', '--path', '--get', 'core.excludesFile'], options).catch(() => '')
  const home = base['HOME'] ?? homedir()
  const xdg = base['XDG_CONFIG_HOME']
  const globalPath = configured.trim() !== '' ? configured.trim() : join(xdg !== undefined && xdg !== '' ? xdg : join(home, '.config'), 'git', 'ignore')
  const infoPath = (await handoffGit(repo, ['rev-parse', '--git-path', 'info/exclude'], options)).trim()
  return {
    global: await digestOf(globalPath),
    info: await digestOf(isAbsolute(infoPath) ? infoPath : resolve(repo, infoPath)),
  }
}

async function digestOf(path: string): Promise<IgnoreFileDigest> {
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined) return 'none'
  const rules = text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
  return rules.length === 0 ? 'none' : createHash('sha256').update(rules.join('\n')).digest('hex')
}
