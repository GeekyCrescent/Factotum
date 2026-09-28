/**
 * The session's own history (started, resumed, finished) gathered out of the conversation: one
 * row per turn, where the turn ended, that opens on a tap. Pure; no DOM (guardrail 11).
 *
 * A turn's states are held until the state that ends it; a turn still running has no row yet, so
 * nothing appears and then moves. The first `running` of a session is "Started", any later one is
 * "Resumed".
 */

import type { SessionState } from '../types.ts'
import type { Row } from './fold.ts'
import { stateLabel } from './format.ts'

export interface ActivityEntry {
  readonly label: string
  readonly at: string
  readonly reason: string | undefined
}

export interface Activity {
  readonly kind: 'activity'
  readonly seq: number
  /** How the turn ended, for the colour of its row. */
  readonly tone: SessionState
  /** "Finished", or "Failed: <reason>": what the row says while closed. */
  readonly summary: string
  readonly at: string
  readonly entries: readonly ActivityEntry[]
}

export type Shown = Exclude<Row, { kind: 'state' }> | Activity

export function activity(rows: readonly Row[]): readonly Shown[] {
  const out: Shown[] = []
  let held: ActivityEntry[] = []
  let started = false
  for (const row of rows) {
    if (row.kind !== 'state') {
      out.push(row)
      continue
    }
    if (row.state === 'running') {
      held = [...held, { label: started ? 'Resumed' : 'Started', at: row.at, reason: row.reason }]
      started = true
      continue
    }
    const label = stateLabel(row.state)
    out.push({
      kind: 'activity',
      seq: row.seq,
      tone: row.state,
      summary: row.reason === undefined ? label : `${label}: ${row.reason}`,
      at: row.at,
      entries: [...held, { label, at: row.at, reason: row.reason }],
    })
    held = []
  }
  return out
}
