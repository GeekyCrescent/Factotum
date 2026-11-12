/**
 * The server's sweep of runs that never got a session (design D5; criterion 18).
 *
 * A run without `sessionId` means the screen died between launching and linking. The session may
 * well be alive and working, so after `STARTING_ABANDON_MS` the run is marked `stalled` — NEVER
 * abandoned: its `submit_stage` is still accepted, and links it. The screen offers «Abandon» earlier
 * (`STARTING_OFFER_MS`), where the owner can see what is going on.
 *
 * The log carries ids and the stage, never content (criterion 42).
 */

import type { Logger } from '@factotum/core'
import { findRun, runsOf, stallRun } from './ops.ts'
import { STARTING_ABANDON_MS } from './shape.ts'
import type { MockupsStore } from './store/store.ts'
import type { MockupsFile } from './types.ts'

export interface StaleRun {
  readonly mockupId: string
  readonly runId: string
}

export function staleRuns(file: MockupsFile, now: Date): readonly StaleRun[] {
  const stale: StaleRun[] = []
  for (const m of file.mockups) {
    for (const { step, run } of runsOf(m)) {
      if (run.sessionId !== undefined || step.status !== 'running') continue
      if (now.getTime() - Date.parse(run.startedAt) >= STARTING_ABANDON_MS) stale.push({ mockupId: m.id, runId: run.id })
    }
  }
  return stale
}

/** One pass: each stale run stalled in its own change, on the file of that moment. Returns how many. */
export async function sweep(store: MockupsStore, now: Date, log: Logger): Promise<number> {
  let count = 0
  for (const stale of staleRuns(store.current(), now)) {
    const result = await store.change((file) => {
      const m = file.mockups.find((one) => one.id === stale.mockupId)
      if (m === undefined) return { ok: false, error: { code: 'not-found', reason: 'gone' } }
      // On the file OF THIS CHANGE: a session linked since the snapshot is alive, and stays running.
      const found = findRun(m, stale.runId)
      if (found === undefined || found.run.sessionId !== undefined || found.step.status !== 'running') {
        return { ok: false, error: { code: 'conflict', reason: 'linked since' } }
      }
      const stalled = stallRun(m, stale.runId, now)
      if (!stalled.ok) return stalled
      const mockups = file.mockups.map((one) => (one.id === m.id ? stalled.value : one))
      return { ok: true, value: { file: { ...file, mockups }, mockup: stalled.value } }
    })
    if (!result.ok) {
      if (result.error.code === 'module-error') log.warn(`mockup ${stale.mockupId}: run ${stale.runId} could not be stalled (${result.error.reason})`)
      continue
    }
    count++
    const kind = findRun(result.value.mockup, stale.runId)?.run.kind ?? 'unknown'
    log.info(`mockup ${stale.mockupId}: ${kind} run ${stale.runId} had no session after ${STARTING_ABANDON_MS / 60_000} min; stalled`)
  }
  return count
}
