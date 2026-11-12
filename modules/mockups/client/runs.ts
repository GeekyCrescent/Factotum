/**
 * Live runs, checked when a mockup opens (design D5; criterion 17): for each run linked to a session,
 * `GET sessions/:id` within 5 s, in parallel; a session that `finished`, `failed`, was `cancelled` or
 * is gone → `POST runs/:runId/stall`. The run is not removed: its late `submit_stage` is still taken.
 * A session that could not be read is left as it is — not knowing is not ending.
 */

import { STAGE_IDS, type Mockup } from '../types.ts'
import type { Api } from './contract.ts'
import { statusOf } from './launch.ts'

export const CHECK_TIMEOUT_MS = 5_000
const ENDED = ['finished', 'failed', 'cancelled']

type Read = 'ended' | 'alive' | 'unknown'

async function readSession(sessions: Api, sessionId: string, timeoutMs: number): Promise<Read> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Read>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), timeoutMs)
  })
  const read = sessions
    .get<{ summary?: { state?: string } }>(`sessions/${encodeURIComponent(sessionId)}`)
    .then((answer): Read => (ENDED.includes(answer.summary?.state ?? '') ? 'ended' : 'alive'))
    .catch((cause: unknown): Read => (statusOf(cause) === 404 ? 'ended' : 'unknown'))
  try {
    return await Promise.race([read, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Returns how many runs were stalled. */
export async function checkLiveRuns(apis: { readonly mockups: Api; readonly sessions: Api | undefined }, m: Mockup, timeoutMs = CHECK_TIMEOUT_MS): Promise<number> {
  const sessions = apis.sessions
  if (sessions === undefined) return 0
  const running = STAGE_IDS.map((id) => m.stages[id]).filter((step) => step.status === 'running' && step.run?.sessionId !== undefined)
  const stalled = await Promise.all(
    running.map(async (step) => {
      const run = step.run
      if (run?.sessionId === undefined) return false
      if ((await readSession(sessions, run.sessionId, timeoutMs)) !== 'ended') return false
      return await apis.mockups
        .post(`runs/${encodeURIComponent(run.id)}/stall`)
        .then(() => true)
        .catch(() => false)
    }),
  )
  return stalled.filter(Boolean).length
}
