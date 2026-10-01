/**
 * Subagents, for the screen (spec 2026-10-01-subagentes-visibles): which are open now, and what a
 * closed one says. Pure; no DOM (guardrail 11).
 *
 * ONE RULE OF WHAT IS OPEN, and it lives in `fold`: a row whose turn has not ended. This reads the
 * rows `fold` made rather than the events, so the line under the log and the row in it cannot
 * disagree about the same subagent.
 */

import type { SessionState } from '../types.ts'
import type { Shown } from './activity.ts'
import type { SubagentRow } from './fold.ts'
import { duration } from './format.ts'

/** What the CLI says when a subagent did not finish because its group was killed (§0.11). */
const INTERRUPTED: ReadonlySet<string> = new Set(['killed', 'stopped'])

/** The subagents of the turn that is running, in the order they started. */
export function openSubagents(rows: readonly Shown[]): readonly SubagentRow[] {
  return rows.filter((row): row is SubagentRow => row.kind === 'subagent' && row.end === undefined)
}

/**
 * What a closed row says, and its tone. `running` decides what a row with no end is: open while the
 * session runs (and then it is not drawn in the log at all), interrupted once it has stopped.
 */
export function outcome(row: SubagentRow, running: boolean): { readonly text: string; readonly tone: SessionState } {
  const end = row.end
  if (end === undefined) return running ? { text: 'running', tone: 'running' } : interrupted()
  if (end.kind === 'interrupted') return interrupted()
  if (end.status === 'completed') return { text: `done in ${duration(row.startedAt, end.at, 0)}`, tone: 'finished' }
  if (INTERRUPTED.has(end.status)) return interrupted()
  return { text: `failed: ${end.status}`, tone: 'failed' }
}

function interrupted(): { readonly text: string; readonly tone: SessionState } {
  return { text: 'interrupted', tone: 'cancelled' }
}
