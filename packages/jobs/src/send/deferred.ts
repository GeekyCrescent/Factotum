/**
 * Deferred replies (v6.1, design D3 «Respuesta mientras el `initial` está `sending`»).
 *
 * While the initial is in flight, D12 «Aplicar» writes only `reply { deferred: true, class, … }`. The
 * `tx` that CLOSES the send — step 3 of D9 (T-S2/T-S3/T-S4) or the opening `tx` after a restart —
 * applies each one not yet cited by a `reply-applied { replyEventId }`, in the same `tx`: the send
 * ends `sent` (T-S2 as is; after T-S3, T-S11 + T-A30; after T-S4, T-S7 + T-A17) and the row of its
 * class follows (T-A20/T-A21/T-A29). Never a `conflict`, never lost.
 *
 * A reply proves the attempt it names (`data.messageId`, the current id or one of `attempts`); when it
 * names none the module knows, it proves the current one: a deferred reply was matched to THIS initial.
 */

import { appTransition, isHumanClass, matchSend, type ReplyClass } from '../state.ts'
import type { Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { ok, type Application, type JobEvent, type Result } from '../types.ts'

const REPLY_CLASSES: readonly ReplyClass[] = ['interview', 'asks-something', 'offer', 'rejection', 'auto-ack', 'other', 'unrelated']
const isReplyClass = (value: unknown): value is ReplyClass => typeof value === 'string' && (REPLY_CLASSES as readonly string[]).includes(value)

/** A matched reply of a human class has been APPLIED to this application (v6, H1); a deferred one waits. */
export const hasHumanReply = (q: Queries, applicationId: string): boolean =>
  repo.eventsOf(q, applicationId).some((e) => e.kind === 'reply' && e.data.deferred !== true && isReplyClass(e.data.class) && isHumanClass(e.data.class))

function provenId(app: Application, reply: JobEvent): string | null {
  const named = reply.data.messageId
  if (typeof named === 'string' && matchSend(app.sends, named) !== null) return named
  return app.sends.find((s) => s.kind === 'initial')?.messageId ?? null
}

function applyOne(q: Queries, app: Application, reply: JobEvent, at: Date): Result<void> {
  const replyClass = reply.data.class
  const cite = { kind: 'reply-applied', data: { replyEventId: reply.id } } as const
  if (!isReplyClass(replyClass)) return ok(void repo.appendEvent(q, { ...cite, data: { ...cite.data, skipped: 'unknown-class' }, applicationId: app.id, companyId: app.companyId }, at))
  const messageId = provenId(app, reply)
  const moved = appTransition(app, { type: 'reply', replyClass, rule: 1, messageId }, at)
  if (!moved.ok) {
    // Cited all the same, with why: a deferred reply is never retried forever nor turned into a conflict.
    return ok(void repo.appendEvent(q, { ...cite, data: { ...cite.data, skipped: moved.error.reason }, applicationId: app.id, companyId: app.companyId }, at))
  }
  const before = app.sends.find((s) => s.kind === 'initial')
  const after = moved.value.sends.find((s) => s.kind === 'initial')
  if (before !== undefined && before.state !== 'sent' && after?.state === 'sent') {
    const viaAttempt = matchSend([before], messageId)?.viaAttempt === true
    const data = { kind: 'initial', rule: 1, ...(viaAttempt ? { viaAttempt } : {}) }
    repo.appendEvent(q, { kind: 'resolved-by-reply', data, applicationId: app.id, companyId: app.companyId }, at) // T-S7 / T-S11
  }
  return repo.saveApplication(q, moved.value, { kind: 'reply-applied', data: { replyEventId: reply.id, class: replyClass } }, at)
}

/** Applies the application's pending deferred replies, unless its initial is still `sending`. Returns how many. */
export function applyDeferredReplies(q: Queries, applicationId: string, at: Date): Result<number> {
  let applied = 0
  for (const reply of repo.pendingDeferredReplies(q, applicationId)) {
    const app = repo.getApplication(q, applicationId)
    if (app === undefined || app.state === 'sending') return ok(applied)
    const done = applyOne(q, app, reply, at)
    if (!done.ok) return done
    applied += 1
  }
  return ok(applied)
}

/**
 * For the daemon's opening `tx`, right after `recoverOnStart` (which leaves every `sending` row
 * `send-unknown`, T-S4): every application with a pending deferred reply gets it applied (T-S7 + T-A17).
 */
export function applyDeferredRepliesOnStart(q: Queries, at: Date): Result<number> {
  let applied = 0
  for (const id of repo.applicationsWithDeferredReplies(q)) {
    const done = applyDeferredReplies(q, id, at)
    if (!done.ok) return done
    applied += done.value
  }
  return ok(applied)
}
