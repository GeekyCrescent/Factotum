/**
 * Reading a failed request STRUCTURALLY, moved as-is out of the old client.tsx (spec 2026-09-18,
 * design D5; criterion 19).
 *
 * The client shell hangs `status` and `body` on an ordinary `Error` rather than exporting a class,
 * precisely so that this can be a cast instead of an import: a class is a value at runtime, and
 * reading one with `instanceof` would mean importing from outside this module's one permitted
 * dependency. Pure, with no DOM, so `modules/tsconfig.json` compiles it too (guardrail 11).
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

/** The 409 of a reply to a conversation moved to another host: that host's name (spec 2026-10-07-dos-hosts). */
export function movedOf(cause: unknown): string | undefined {
  const error = cause as { status?: number; body?: { moved?: { to?: unknown } } }
  return error?.status === 409 && typeof error.body?.moved?.to === 'string' ? error.body.moved.to : undefined
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

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function describe(report: Freshness): string {
  const parts: string[] = []
  if (report.behind > 0) parts.push(`${report.behind} commit${report.behind === 1 ? '' : 's'} behind`)
  if (!report.clean) parts.push(`uncommitted: ${report.dirtyFiles.join(', ')}`)
  if (report.remoteWarning !== undefined) parts.push(report.remoteWarning)
  if (report.pullError !== undefined) parts.push(report.pullError)
  return parts.join(' · ')
}
