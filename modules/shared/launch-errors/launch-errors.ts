/**
 * Reading a failed LAUNCH of the sessions module, from another module's screen: «Run agent» of tasks
 * (spec 2026-10-14-tareas-kanban, design D9) and the mockup stages (spec 2026-11-12-maquetas, D5).
 *
 * A COPY of the sessions module's launch errors (`modules/sessions/client/errors.ts`, 2026-10-15), moved
 * here from tasks when mockups became its second consumer, as the dictation did. Sessions keeps its own:
 * that file also carries `messageOf` and `movedOf` and has sixteen importers, so splitting it is a move no
 * consumer asks for. If those change, this copy stays behind; declared. `movedOf` is not copied: it reads
 * a REPLY's 409, and a launch never answers `moved`. Imports nothing from any module.
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
