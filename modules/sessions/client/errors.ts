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

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function describe(report: Freshness): string {
  const parts: string[] = []
  if (report.behind > 0) parts.push(`${report.behind} commit${report.behind === 1 ? '' : 's'} behind`)
  if (!report.clean) parts.push(`uncommitted: ${report.dirtyFiles.join(', ')}`)
  if (report.remoteWarning !== undefined) parts.push(report.remoteWarning)
  return parts.join(' · ')
}
