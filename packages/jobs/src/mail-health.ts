/**
 * The health of the app password's file (design D13 `start` step 5; tasks C1, v4 B6).
 *
 * `start()` LAUNCHES `check()` WITHOUT WAITING FOR IT: an `lstat` — exists, a regular file, not a
 * symlink, nobody else may read it, not empty — and NEVER THE CONTENT. The answer goes to a cache in
 * memory; `current()` is synchronous and only reads that cache (`unknown` until the `lstat` is back,
 * milliseconds later). `health()` shows it; the module stays on whatever it says.
 *
 * EVERY REAL READ REFRESHES IT: `readPassword` here wraps `@factotum/mail`'s, and the sender (D9 step 2)
 * and the reply reader (D12) are given this one — a file fixed by hand shows at its next use.
 *
 * A REASON NEVER CARRIES THE PATH NOR THE VALUE.
 *
 * THE MODE RULE IS `readPassword`'s (group and others have no bit), not «exactly 0600»: a 0400 file
 * sends, so health does not call it bad.
 */

import { lstat as fsLstat } from 'node:fs/promises'

import { readPassword as mailReadPassword, type PasswordResult } from '@factotum/mail'

export type MailHealthState = 'unknown' | 'ok' | 'bad'

export interface MailHealth {
  readonly state: MailHealthState
  /** «Mail: password file is …»; null unless `bad`. */
  readonly reason: string | null
  /** When it was last learnt; null while `unknown`. */
  readonly at: string | null
}

/** What `lstat` answers, as far as the check reads it. */
export interface FileStat {
  readonly isSymbolicLink: () => boolean
  readonly isFile: () => boolean
  readonly mode: number
  readonly size: number
}

export interface PasswordHealthDeps {
  readonly file: string
  readonly now: () => Date
  /** The seam for a test; `fs/promises` `lstat`. */
  readonly lstat?: (path: string) => Promise<FileStat>
  /** The seam for a test; `@factotum/mail`'s. */
  readonly readPassword?: (file: string) => Promise<PasswordResult>
}

export interface PasswordHealth {
  /** One `lstat` of the file, into the cache. Never throws; never reads the content. */
  readonly check: () => Promise<void>
  /** The cache. Synchronous. */
  readonly current: () => MailHealth
  /** The real read, which refreshes the cache with its outcome. */
  readonly readPassword: (file: string) => Promise<PasswordResult>
}

const PREFIX = 'Mail: '
const UNKNOWN: MailHealth = { state: 'unknown', reason: null, at: null }

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'error'
}

/** What is wrong with the file, from its `lstat`; null when nothing is. */
function problemOf(stats: FileStat): string | null {
  if (stats.isSymbolicLink()) return 'password file is a symlink'
  if (!stats.isFile()) return 'password file is not a regular file'
  if ((stats.mode & 0o077) !== 0) return `password file is readable by others (mode ${(stats.mode & 0o777).toString(8)}); chmod 600 it`
  if (stats.size === 0) return 'password file is empty'
  return null
}

export function createPasswordHealth(deps: PasswordHealthDeps): PasswordHealth {
  const lstat = deps.lstat ?? fsLstat
  const read = deps.readPassword ?? mailReadPassword
  let cached: MailHealth = UNKNOWN

  const learn = (problem: string | null): void => {
    const at = deps.now().toISOString()
    cached = problem === null ? { state: 'ok', reason: null, at } : { state: 'bad', reason: `${PREFIX}${problem}`, at }
  }

  return {
    check: async () => {
      try {
        learn(problemOf(await lstat(deps.file)))
      } catch (error) {
        const code = codeOf(error)
        learn(code === 'ENOENT' ? 'password file is missing' : `password file cannot be read (${code})`)
      }
    },
    current: () => cached,
    readPassword: async (file) => {
      const result = await read(file)
      learn(result.ok ? null : result.reason)
      return result
    },
  }
}
