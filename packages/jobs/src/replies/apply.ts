/**
 * Applying a classified reply (design D12 «Aplicar»; tasks Q4; requirements crit. 54, 55, 62), in the
 * queue's `tx` of the return — the classifier's `apply`.
 *
 * THE GUARD IS `mail_seen` (D3 «La guarda»: a classification is applied once, by its key): a mail
 * already seen is a no-op; applying it marks it seen in the same `tx`.
 *
 * ALWAYS a `reply` event, dated WITH THE MAIL (`at`), with its class, sender, subject, Gmail link and
 * Claude's summary — NEVER THE BODY. The transition is `state.ts`'s single table (`appTransition`
 * `reply`), which already holds every row of D3 that applies:
 * - a send it proves (`send-unknown` by any rule on the initial, by rule 1 on a follow-up; `failed`
 *   by rule 1) goes `sent` first (T-S7, T-S11; T-A17, T-A30), and its `resolved-by-reply { kind, rule,
 *   viaAttempt? }` is written BEFORE the reply; a follow-up's own row follows its send (T-F9, T-F14);
 * - ONLY A HUMAN CLASS changes the application (T-A20, T-A21, T-A23–T-A25; v6 H1): a `closed` one
 *   reopened leaves `reopened-by-reply { outcomeBefore, class }`; every follow-up not sent (`draft`,
 *   `ready`, `rewriting`, `failed`) is cancelled and so leaves the batch (T-F11, crit. 62); `auto-ack`,
 *   `other` and `unrelated` leave only their event (T-A29);
 * - `interview` and `offer` push «Interview: <company>» / «Offer: <company>», «Tap to open.» (D16) —
 *   through `deps.push`, which the wiring sends only once the `tx` committed. Nothing of the mail, the
 *   letter or the summary goes in it (guardrail 10);
 * - with the initial `sending` (v6.1) only `reply { deferred: true }` is written: no state, no push —
 *   the `tx` that closes the send applies it (`send/deferred.ts`).
 *
 * NO APPLICATION TO NAME (several candidates and Claude named none, or it is gone): an «Unmatched
 * reply», like rule 4, with Claude's class and summary — unless it is `unrelated`, which is only seen.
 *
 * NOTHING HERE LOGS: the sender, the subject and the summary live in the event, never in a log line.
 */

import type { NotificationMessage } from '@factotum/core'

import { appTransition, followupTransition, isHumanClass } from '../state.ts'
import type { Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { ok, type Application, type Result, type Send } from '../types.ts'
import type { ClassifyVerdict, ReplyJob } from './classify.ts'
import type { ReadReply } from './read.ts'

/** design D16: the company in a push title is cut to this. */
export const PUSH_COMPANY_MAX = 40
/** design D16. */
export const PUSH_BODY = 'Tap to open.'

export interface ApplyDeps {
  /**
   * A push for an interview or an offer, keyed by the mail: the wiring sends it once the `tx` that
   * marked that key seen has committed, never from inside it.
   */
  readonly push: (key: string, message: NotificationMessage) => void
}

/** Where a classified reply lands: its application, by which rule, and the messageId it named (rule 1). */
interface Target {
  readonly applicationId: string
  readonly rule: 1 | 2 | 3
  readonly messageId: string | null
  readonly viaAttempt: boolean
}

/** Rule 1 names its application; rules 2–3 take Claude's pick among the candidates, or the only one. */
function targetOf(reply: ReadReply, verdict: ClassifyVerdict): Target | null {
  const { match } = reply
  if (match.kind === 'thread') return { applicationId: match.applicationId, rule: 1, messageId: match.messageId, viaAttempt: match.viaAttempt }
  if (match.kind !== 'candidates') return null
  const named = verdict.applicationId !== null && match.applicationIds.includes(verdict.applicationId) ? verdict.applicationId : null
  const only = match.applicationIds.length === 1 ? (match.applicationIds[0] ?? null) : null
  const id = named ?? only
  return id === null ? null : { applicationId: id, rule: match.rule, messageId: null, viaAttempt: false }
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** D16: «Interview: <company ≤ 40>» / «Offer: …», «Tap to open.», the application's page. */
export function replyPush(applicationId: string, company: string, replyClass: 'interview' | 'offer'): NotificationMessage {
  const label = replyClass === 'interview' ? 'Interview' : 'Offer'
  return { title: `${label}: ${cut(company, PUSH_COMPANY_MAX)}`, body: PUSH_BODY, path: `/m/jobs/a/${applicationId}`, tag: `jobs-reply-${applicationId}` }
}

/** What every `reply` event carries (D12): never the body. */
function replyData(reply: ReadReply, verdict: ClassifyVerdict | null): Readonly<Record<string, unknown>> {
  return {
    key: reply.key,
    ...(verdict === null ? {} : { class: verdict.class }),
    from: reply.from,
    subject: reply.subject,
    link: reply.gmailLink,
    ...(verdict === null ? {} : { summary: verdict.summary }),
  }
}

function seen(q: Queries, reply: ReadReply, applicationId: string | null, cls: string, now: Date): void {
  repo.markMailSeen(q, { key: reply.key, uidValidity: reply.uidValidity, uid: reply.uid, messageId: reply.messageId, applicationId, class: cls }, now)
}

/**
 * An «Unmatched reply» (D12 rule 4; crit. 56): a `reply` event of no application, with sender, subject
 * and link (and Claude's class and summary when it classified it), and the mail seen. Once per key.
 */
export function recordUnmatched(q: Queries, reply: ReadReply, now: Date, verdict: ClassifyVerdict | null = null): Result<void> {
  if (repo.mailSeen(q, reply.key, reply.messageId)) return ok(undefined)
  repo.appendEvent(q, { kind: 'reply', at: reply.date, data: { ...replyData(reply, verdict), unmatched: true }, applicationId: null, companyId: null }, now)
  seen(q, reply, null, 'unmatched', now)
  return ok(undefined)
}

/** The sends the reply moved to `sent` (T-S7, T-S11): `resolved-by-reply` for each, the follow-up's row with its send. */
function resolveSends(q: Queries, before: Application, after: Application, target: Target, now: Date): Result<void> {
  for (const moved of after.sends) {
    const was = before.sends.find((s) => s.kind === moved.kind)
    if (was === undefined || was.state === moved.state || moved.state !== 'sent') continue
    const data = { kind: moved.kind, rule: target.rule, ...(target.rule === 1 && target.viaAttempt ? { viaAttempt: true } : {}) }
    if (moved.followupId === null) {
      repo.appendEvent(q, { kind: 'resolved-by-reply', data, applicationId: after.id, companyId: after.companyId }, now)
      continue
    }
    const done = resolveFollowup(q, moved.followupId, moved, data, now)
    if (!done.ok) return done
  }
  return ok(undefined)
}

function resolveFollowup(q: Queries, followupId: string, sendRow: Send, data: Readonly<Record<string, unknown>>, now: Date): Result<void> {
  const row = repo.getFollowup(q, followupId)
  if (row === undefined) return ok(undefined)
  const moved = followupTransition(row, { type: 'reply' }, now) // T-F9, T-F14
  if (!moved.ok) return moved
  return repo.saveFollowup(q, moved.value, { kind: 'resolved-by-reply', data }, now, sendRow)
}

/** T-F11: every follow-up of the application not sent (`draft`, `ready`, `rewriting`, `failed`) → `cancelled`. */
function cancelFollowups(q: Queries, applicationId: string, now: Date): Result<void> {
  for (const row of repo.followupsOf(q, applicationId)) {
    const moved = followupTransition(row, { type: 'cancel', why: 'replied' }, now)
    if (!moved.ok) continue // sending, sent, send-unknown, cancelled: not this row's to cancel
    const saved = repo.saveFollowup(q, moved.value, { kind: 'followup-cancelled', data: { why: 'replied' } }, now)
    if (!saved.ok) return saved
  }
  return ok(undefined)
}

/** The classifier's `apply` (Q3 → Q4): one classified reply, in the caller's `tx`. */
export function applyReply(q: Queries, job: ReplyJob, verdict: ClassifyVerdict, now: Date, deps: ApplyDeps): Result<void> {
  const { reply } = job
  if (repo.mailSeen(q, reply.key, reply.messageId)) return ok(undefined)
  const target = targetOf(reply, verdict)
  const app = target === null ? undefined : repo.getApplication(q, target.applicationId)
  if (target === null || app === undefined) {
    if (verdict.class !== 'unrelated') return recordUnmatched(q, reply, now, verdict)
    seen(q, reply, null, verdict.class, now)
    return ok(undefined)
  }
  const data = { ...replyData(reply, verdict), rule: target.rule, ...(target.messageId === null ? {} : { messageId: target.messageId }) }
  const event = (extra: Readonly<Record<string, unknown>> = {}) => ({ kind: 'reply', at: reply.date, data: { ...data, ...extra } }) as const

  if (app.state === 'sending') {
    // v6.1: the event only; the close of the send applies it (T-S2/T-S3/T-S4).
    repo.appendEvent(q, { ...event({ deferred: true }), applicationId: app.id, companyId: app.companyId }, now)
    seen(q, reply, app.id, verdict.class, now)
    return ok(undefined)
  }

  const moved = appTransition(app, { type: 'reply', replyClass: verdict.class, rule: target.rule, messageId: target.messageId }, now)
  if (!moved.ok) {
    // D3 says a matched reply is never a conflict; should the table refuse one all the same, the reply is kept.
    repo.appendEvent(q, { ...event({ notApplied: moved.error.reason }), applicationId: app.id, companyId: app.companyId }, now)
    seen(q, reply, app.id, verdict.class, now)
    return ok(undefined)
  }
  const next = moved.value
  const resolved = resolveSends(q, app, next, target, now)
  if (!resolved.ok) return resolved
  if (app.state === 'closed' && next.state === 'replied') {
    repo.appendEvent(q, { kind: 'reopened-by-reply', data: { outcomeBefore: app.outcome, class: verdict.class }, applicationId: app.id, companyId: app.companyId }, now) // T-A24
  }
  const saved = repo.saveApplication(q, next, event(), now)
  if (!saved.ok) return saved
  if (isHumanClass(verdict.class)) {
    const cancelled = cancelFollowups(q, app.id, now)
    if (!cancelled.ok) return cancelled
  }
  seen(q, reply, app.id, verdict.class, now)
  if (verdict.class === 'interview' || verdict.class === 'offer') {
    deps.push(reply.key, replyPush(app.id, repo.getCompany(q, app.companyId)?.name ?? '', verdict.class))
  }
  return ok(undefined)
}
