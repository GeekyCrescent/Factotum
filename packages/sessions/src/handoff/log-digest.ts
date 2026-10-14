/**
 * A session's log as a digest the other host can compare against (spec 2026-10-07-dos-hosts, D7).
 *
 * ONE RULE, used by the preview and by the source's step 4: the TARGET digests its whole log
 * (`logDigest`, returned by `sessions-check` and `prepare`), and the SOURCE hashes its own first
 * `lines` lines and compares (`extendsLog`). The target compares nothing.
 *
 * Only COMPLETE lines count: a daemon killed mid-write leaves half a line, which `parseLine` skips
 * and which must not make two identical histories look different.
 */

import { createHash } from 'node:crypto'

export interface LogDigest {
  readonly lines: number
  readonly sha256: string
}

function completeLines(text: string): readonly string[] {
  const parts = text.split('\n')
  // The last part is what follows the last newline: empty for a log that ends cleanly, half a line otherwise.
  return parts.slice(0, -1)
}

function digestOf(lines: readonly string[]): string {
  const hash = createHash('sha256')
  for (const line of lines) hash.update(`${line}\n`)
  return hash.digest('hex')
}

export function logDigest(text: string): LogDigest {
  const lines = completeLines(text)
  return { lines: lines.length, sha256: digestOf(lines) }
}

/**
 * Whether the log here EXTENDS the one the other host has: its first `remote.lines` lines are exactly
 * those. If not, the project is `history-diverged` — both copies went on without each other.
 */
export function extendsLog(localText: string, remote: LogDigest): boolean {
  const lines = completeLines(localText)
  if (lines.length < remote.lines) return false
  return digestOf(lines.slice(0, remote.lines)) === remote.sha256
}
