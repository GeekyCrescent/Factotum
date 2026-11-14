/**
 * «Close» of the engine (design D3 T-A26, T-A21; tasks C1, v7 of v6.1): an application the owner will
 * not send, or one already sent he is done with, goes `closed` with his reason.
 *
 * A PLAIN FUNCTION OVER THE STORE: the facade's `close` wraps it, and the CLI (`factotum jobs
 * test-application --close`) calls it straight on a `jobs.db` it opened beside the daemon — never
 * `createJobs`, never `start`, and so never the startup write (D3 «La postulación de prueba»).
 *
 * Not from `sending`/`send-unknown`: the send is settled first (the table refuses it, `conflict`).
 * What comes back late from the queue for a closed application is kept as a version only (G4).
 */

import { appTransition } from '../state.ts'
import type { Db } from '../store/db.ts'
import { getApplication, saveApplication } from '../store/repo.ts'
import { fail, type Application, type Result } from '../types.ts'

/** The same bound as a skip's text (`review/decide.ts`). */
export const MAX_CLOSE_REASON_CHARS = 200

export interface CloseContext {
  readonly now: () => Date
}

export interface CloseInput {
  readonly reason: string
}

function reasonOf(input: CloseInput | undefined): Result<string> {
  const raw: unknown = input?.reason
  const reason = typeof raw === 'string' ? raw.trim() : ''
  if (reason === '') return fail('invalid', 'a close needs a reason', 'reason')
  if (reason.length > MAX_CLOSE_REASON_CHARS) return fail('invalid', `a reason is at most ${MAX_CLOSE_REASON_CHARS} characters`, 'reason')
  return { ok: true, value: reason }
}

export function closeApplication(db: Db, ctx: CloseContext, id: string, input: CloseInput): Result<Application> {
  const reason = reasonOf(input)
  if (!reason.ok) return reason
  return db.tx((q) => {
    const app = getApplication(q, id)
    if (app === undefined) return fail('not-found', 'no such application')
    const now = ctx.now()
    const moved = appTransition(app, { type: 'close', reason: reason.value }, now) // T-A26, T-A21
    if (!moved.ok) return moved
    const saved = saveApplication(q, moved.value, { kind: 'closed', data: { reason: reason.value, outcome: moved.value.outcome, from: app.state } }, now)
    return saved.ok ? { ok: true, value: moved.value } : saved
  })
}
