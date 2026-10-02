/**
 * The services of one session, AS ITS LOG TELLS THEM (spec 2026-10-02-servicios-en-segundo-plano, D5 bis).
 * Pure.
 *
 * WHAT ENDED IS READ FROM HERE, NOT FROM MEMORY. The table only holds the live ones; a service that ended
 * — or every service, after a restart — is still answerable by `service_output`, `stop_service`,
 * `list_services` and the owner's routes (criterion 39). Only an id with no `started` in the session is
 * "no such service" (criterion 8).
 *
 * One `ended` per `started` is the table's promise (criterion 32); here the FIRST one wins anyway, and an
 * `ended` with no `started` before it is ignored.
 */

import type { SessionEvent } from '../types.ts'
import type { ServiceView } from './shape.ts'

export function servicesFromLog(events: readonly SessionEvent[]): readonly ServiceView[] {
  const views = new Map<string, ServiceView>()
  for (const event of events) {
    if (event.kind !== 'service') continue
    if (event.phase === 'started') {
      if (views.has(event.id)) continue
      views.set(event.id, {
        id: event.id,
        command: event.command,
        description: event.description,
        cwd: event.cwd,
        pid: event.pid,
        maxMinutes: event.maxMinutes,
        startedAt: event.at,
        task: event.task,
        state: 'running',
        endedAt: undefined,
        by: undefined,
        code: undefined,
        signal: undefined,
        reason: undefined,
      })
      continue
    }
    const view = views.get(event.id)
    if (view === undefined || view.state !== 'running') continue
    views.set(event.id, {
      ...view,
      state: event.outcome,
      endedAt: event.at,
      by: event.by,
      code: event.code,
      signal: event.signal,
      reason: event.reason,
    })
  }
  return [...views.values()]
}
