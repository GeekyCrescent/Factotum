/**
 * Background services, for the screen (spec 2026-10-02-servicios-en-segundo-plano, D14): which are alive,
 * and what an ended one says. Pure; no DOM (guardrail 11).
 *
 * ONE RULE OF WHAT IS ALIVE, and it lives in `fold`: a row with no `ended`. `liveServices` reads the rows,
 * so the line under the log and the row in it cannot disagree. `hasLiveService` reads the EVENTS, only for
 * the poll — which must keep going after the session stops running (criterion 35) — and a test holds the
 * two to the same answer.
 */

import type { ServiceView, SessionEvent, SessionState } from '../types.ts'
import type { Shown } from './activity.ts'
import type { ServiceRow } from './fold.ts'
import { duration } from './format.ts'

/** The live services, in the order they started. */
export function liveServices(rows: readonly Shown[]): readonly ServiceRow[] {
  return rows.filter((row): row is ServiceRow => row.kind === 'service' && row.end === undefined)
}

/** Whether the log leaves any service alive: some `started` with no `ended`. */
export function hasLiveService(events: readonly SessionEvent[]): boolean {
  const alive = new Set<string>()
  const over = new Set<string>()
  for (const event of events) {
    if (event.kind !== 'service') continue
    if (event.phase === 'started') alive.add(event.id)
    else if (alive.has(event.id)) over.add(event.id)
  }
  return alive.size > over.size
}

/** What a row says and its tone (criterion 34). `now` for how long a live one has run. */
export function serviceOutcome(row: ServiceRow, now: number): { readonly text: string; readonly tone: SessionState } {
  const end = row.end
  if (end === undefined) return { text: `running · ${duration(row.startedAt, undefined, now)}`, tone: 'running' }
  switch (end.outcome) {
    case 'exited':
      return { text: 'exited', tone: 'finished' }
    case 'failed':
      return { text: end.code !== undefined ? `failed: code ${end.code}` : end.signal !== undefined ? `failed: ${end.signal}` : 'failed', tone: 'failed' }
    case 'stopped':
      return { text: 'stopped', tone: 'cancelled' }
    case 'timeout':
      return { text: 'timed out', tone: 'cancelled' }
    case 'cancelled':
      return { text: 'cancelled', tone: 'cancelled' }
    case 'shutdown':
      return { text: 'stopped by restart', tone: 'cancelled' }
  }
}

/** The same words for a `ServiceView`, which is what the sheet reads from the route. */
export function viewOutcome(view: ServiceView, now: number): { readonly text: string; readonly tone: SessionState } {
  const end =
    view.state === 'running'
      ? undefined
      : { outcome: view.state, at: view.endedAt ?? view.startedAt, code: view.code, signal: view.signal, reason: view.reason }
  return serviceOutcome(
    { kind: 'service', seq: 0, id: view.id, command: view.command, description: view.description, startedAt: view.startedAt, by: undefined, end },
    now,
  )
}
