/**
 * Reading a failed LAUNCH of the sessions module, for «Run agent» (design D9; criteria 31, 31b).
 *
 * A COPY, NOT AN IMPORT: copied from the sessions module's launch errors (2026-10-15), because this
 * module cannot import that one (criterion 44). If those change, this copy stays behind; accepted until
 * a second consumer asks for them to move to `modules/shared/`, as the dictation did. `movedOf` is not
 * copied: it reads a REPLY's 409, and a launch never answers `moved`.
 *
 * Pure and structural: the shell hangs `status` and `body` on an ordinary `Error`, read by a cast.
 */

export interface Conflict {
  readonly sessionId: string
}

export interface Freshness {
  readonly clean: boolean
  readonly behind: number
  readonly dirtyFiles: readonly string[]
  readonly remoteWarning?: string
  /** The fast-forward before launching could not be made (spec 2026-10-07-dos-hosts, D5). */
  readonly pullError?: string
}

/** The 409 body of a busy site, read WITHOUT importing anything (see the header). */
export function conflictOf(cause: unknown): Conflict | undefined {
  const error = cause as { status?: number; body?: { conflict?: { sessionId?: string } } }
  return error?.status === 409 && typeof error.body?.conflict?.sessionId === 'string'
    ? { sessionId: error.body.conflict.sessionId }
    : undefined
}

export function freshnessOf(cause: unknown): Freshness | undefined {
  const error = cause as { status?: number; body?: { freshness?: Freshness } }
  return error?.status === 409 && error.body?.freshness !== undefined ? error.body.freshness : undefined
}

/**
 * A launch ON ANOTHER HOST that came back 502 (spec 2026-10-07-dos-hosts, design D3, D12): the proxy
 * stopped waiting, and the peer may well have started it. Never retried by itself — the screen says
 * so and reads that host's sessions again. On the serving host a 502 is `tailscale serve` with no
 * daemon behind it: nothing started, and it is an ordinary error.
 */
export function launchUnanswered(cause: unknown, host: string | undefined): boolean {
  return host !== undefined && (cause as { status?: number } | undefined)?.status === 502
}

export function describe(report: Freshness): string {
  const parts: string[] = []
  if (report.behind > 0) parts.push(`${report.behind} commit${report.behind === 1 ? '' : 's'} behind`)
  if (!report.clean) parts.push(`uncommitted: ${report.dirtyFiles.join(', ')}`)
  if (report.remoteWarning !== undefined) parts.push(report.remoteWarning)
  if (report.pullError !== undefined) parts.push(report.pullError)
  return parts.join(' · ')
}
