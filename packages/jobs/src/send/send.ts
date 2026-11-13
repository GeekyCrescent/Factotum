/**
 * Sending one email (design D9, tasks E1–E2): the THREE STEPS on the `sends(kind)` row, the same path
 * for the `initial` and for a follow-up.
 *
 * 1. `tx`: the guards (state, PDF on disk for the initial, address, daily cap) and the row `sending`
 *    with its `Message-ID` — all decided by `state.ts`, written here with `approved { kind }`.
 * 2. Outside any `tx`: `readPassword`, the slots filled with the profile version the row recorded,
 *    and `sendMail` (the CV attached ONLY to the initial).
 * 3. `tx`: `sent` | `failed` | `send-unknown` with its event; for the initial, the deferred replies
 *    (v6.1) are applied in a SECOND `tx` that cannot undo the first (revisión de E): a mail SMTP took
 *    is never written back to `sending`.
 *
 * `approve` DOES STEP 1 AND RETURNS: steps 2–3 run in a registered promise that never rejects, which
 * `stop()` aborts and waits for — and then step 3 is NOT written (D9 step 5): the row stays `sending`
 * and the next start makes it `send-unknown`; what the aborted attempt did (an SMTP `250` with its
 * messageId included) goes to the log only. Nothing here retries by itself.
 *
 * NEVER IN AN EVENT, A REASON OR THE LOG: the password, the body, the subject, the address.
 */

import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import type { Logger, Timers } from '@factotum/core'
import type { PasswordResult, SendInput, SendResult } from '@factotum/mail'
import { uuidv7 } from '@factotum/sessions'

import { addressTransition, appTransition, approvalGate, followupTransition, sendTransition, type DailyCap } from '../state.ts'
import type { Db, Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { fail, ok, type Address, type Application, type Followup, type Result, type Send, type SendKind } from '../types.ts'
import { applyDeferredReplies, hasHumanReply } from './deferred.ts'
import { outgoingFor, type Outgoing } from './message.ts'
import { recipientOf } from './recipient.ts'

export const MESSAGE_ID_HOST = 'jobs.factotum.local'
/** The reason `stop()` aborts with: never classified, never written (D9 step 5). */
export const STOPPING = 'stopping'
/** The reason of a step 2 that threw (D9, revisión de E). */
export const INTERNAL_ERROR = 'internal-error'
const DAY_MS = 86_400_000
/** Every zone is within ±14 h of UTC, so today's rows changed in the last two days. */
const CAP_WINDOW_MS = 2 * DAY_MS

/** The part of `config.mail` a send reads (design D13). */
export interface MailSettings {
  readonly address: string
  readonly displayName: string
  readonly passwordFile: string
  readonly smtpHost: string
  readonly maxSendsPerDay: number
}

/** N4's `enqueueCheck`, injected (the check queue is built elsewhere). */
export type Enqueue = (contactId: string, options: { readonly front: true }) => unknown

export interface SenderDeps {
  readonly db: Db
  readonly now: () => Date
  readonly timers: Timers
  /** The module's zone: «today» of the daily cap. */
  readonly timeZone: string
  readonly mail: MailSettings
  readonly readPassword: (file: string) => Promise<PasswordResult>
  readonly sendMail: (input: SendInput) => Promise<SendResult>
  readonly enqueueCheck: Enqueue
  readonly log: Logger
  /** Where a relative artifact path is resolved (`<stateDir>`); absolute paths are taken as they are. */
  readonly stateDir?: string
  /** Applying the initial's deferred replies after step 3 (v6.1); `applyDeferredReplies` unless a test replaces it. */
  readonly applyDeferred?: typeof applyDeferredReplies
}

export interface ApproveOptions {
  /** «Send anyway» (second click): writes the contact's override (T-D5) when the check finished unverified. */
  readonly addressOverride?: boolean
}

export interface Approved {
  readonly state: 'sending' | 'approved'
  readonly kind: SendKind
}

export interface Sender {
  /** Step 1 in its `tx`; launches 2–3 and returns at once (D9 step 4). What `decide({ kind: 'approve' })` calls. */
  readonly approve: (id: string, kind: SendKind, options?: ApproveOptions) => Result<Approved>
  /** Steps 2–3 for a row ALREADY `sending` («Send again», «Retry»: assist.ts writes their step 1). Whether it launched (not after `stop`). */
  readonly launch: (id: string, kind: SendKind) => boolean
  /** The client's poll (`GET /a/:id/sends/:kind`). */
  readonly send: (id: string, kind: SendKind) => Result<Send>
  /** Resolves when every send in flight has finished (tests, and `stop`). */
  readonly settled: () => Promise<void>
  /** Aborts every SMTP attempt in flight (reason `stopping`) and waits; their step 3 is not written. Then refuses new ones. */
  readonly stop: () => Promise<void>
}

export const newMessageId = (now: Date): string => `<${uuidv7(now.getTime())}@${MESSAGE_ID_HOST}>`

/** `YYYY-MM-DD` of an instant in a zone. */
export function dayIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/** E2: `smtp` rows not `failed` changed today in the module's zone, of ANY application and kind. A «Mark as sent» is `manual`: never counted. */
export function dailyCap(q: Queries, now: Date, timeZone: string, maxPerDay: number): DailyCap {
  const today = dayIn(now, timeZone)
  const since = new Date(now.getTime() - CAP_WINDOW_MS).toISOString()
  const sentToday = repo.smtpSendTimesSince(q, since).filter((at) => dayIn(new Date(at), timeZone) === today).length
  return { sentToday, maxPerDay }
}

const addressOf = (q: Queries, contactId: string | null): Address | null => (contactId === null ? null : (repo.getContact(q, contactId)?.address ?? null))

const followupN = (kind: SendKind): 1 | 2 | null => (kind === 'followup-1' ? 1 : kind === 'followup-2' ? 2 : null)

export function followupOf(q: Queries, app: Application, kind: SendKind): Followup | undefined {
  const n = followupN(kind)
  return n === null ? undefined : repo.followupsOf(q, app.id).find((f) => f.n === n)
}

/** T-D5 beside T-A11/T-F6: «Send anyway» on a finished unverified check writes the override on the CONTACT. */
export function writeOverride(q: Queries, contactId: string | null, address: Address | null, sendAnyway: boolean, at: Date): Result<void> {
  const gate = approvalGate(address, at, sendAnyway)
  if (!gate.ok || gate.value.override !== 'new' || contactId === null) return ok(undefined)
  const contact = repo.getContact(q, contactId)
  if (contact === undefined) return fail('not-found', 'no such contact')
  const moved = addressTransition(contact, { type: 'send-anyway' }, at)
  return moved.ok ? repo.saveContact(q, moved.value, { kind: 'address-override' }, at) : moved
}

/** The contact whose check `check-pending` waits for. */
function contactOf(q: Queries, id: string, kind: SendKind): string | null {
  const app = repo.getApplication(q, id)
  if (app === undefined) return null
  return kind === 'initial' ? app.target.contactId : (followupOf(q, app, kind)?.contactId ?? null)
}

/** X4: a refusal `check-pending` queues the contact's check in front, outside the `tx` (T-D2). Returns the refusal. */
export function enqueueIfPending<T>(db: Db, enqueue: Enqueue, id: string, kind: SendKind, refused: Result<T>): Result<T> {
  if (refused.ok || refused.error.reason !== 'check-pending') return refused
  const contactId = db.read((q) => contactOf(q, id, kind))
  if (contactId !== null) enqueue(contactId, { front: true })
  return refused
}

const then = <T>(written: Result<void>, value: T): Result<T> => (written.ok ? ok(value) : written)

export function createSender(deps: SenderDeps): Sender {
  const { db, log } = deps
  const applyDeferred = deps.applyDeferred ?? applyDeferredReplies
  const inFlight = new Set<{ readonly controller: AbortController; readonly done: Promise<void> }>()
  let stopped = false

  const capOf = (q: Queries, at: Date): DailyCap => dailyCap(q, at, deps.timeZone, deps.mail.maxSendsPerDay)
  const resolvePath = (path: string): string => (isAbsolute(path) || deps.stateDir === undefined ? path : join(deps.stateDir, path))

  /** `stat` BEFORE the `tx` (D9 step 1): the current version's PDF is on the disk. */
  function pdfExists(id: string): boolean {
    const pdf = db.read((q) => {
      const app = repo.getApplication(q, id)
      return app === undefined ? null : (repo.getArtifacts(q, id, app.version)?.pdf ?? null)
    })
    return pdf !== null && existsSync(resolvePath(pdf))
  }

  function beginInitial(id: string, sendAnyway: boolean, at: Date): Result<Approved['state']> {
    const hasPdf = pdfExists(id)
    return db.tx((q) => {
      const app = repo.getApplication(q, id)
      if (app === undefined) return fail('not-found', 'no such application')
      const address = addressOf(q, app.target.contactId)
      const profileVersion = repo.latestProfileVersion(q)?.version ?? null
      const event = { type: 'approve', pdfExists: hasPdf, address, sendAnyway, cap: capOf(q, at), messageId: newMessageId(at), profileVersion } as const
      const moved = appTransition(app, event, at)
      if (!moved.ok) return moved
      const approved = { kind: 'approved', data: { kind: 'initial' } } as const
      if (moved.value.state === 'approved') return then(repo.saveApplication(q, moved.value, approved, at), 'approved') // T-A12
      const recipient = recipientOf(q, app.target.contactId, app.target.to)
      if (!recipient.ok) return recipient
      const override = writeOverride(q, app.target.contactId, address, sendAnyway, at)
      if (!override.ok) return override
      return then(repo.saveApplication(q, moved.value, approved, at), 'sending') // T-A11 + T-S1 / T-S8
    })
  }

  function beginFollowup(id: string, kind: SendKind, sendAnyway: boolean, at: Date): Result<Approved['state']> {
    return db.tx((q) => {
      const app = repo.getApplication(q, id)
      const f = app === undefined ? undefined : followupOf(q, app, kind)
      if (app === undefined || f === undefined) return fail('not-found', `no such ${app === undefined ? 'application' : 'follow-up'}`)
      if (app.sends.some((s) => s.kind === kind)) return fail('conflict', 'the follow-up already has a send')
      const address = addressOf(q, f.contactId)
      const context = { state: app.state, hasHumanReply: hasHumanReply(q, app.id) }
      const moved = followupTransition(f, { type: 'approve', app: context, address, sendAnyway, cap: capOf(q, at) }, at) // T-F6
      if (!moved.ok) return moved
      const recipient = recipientOf(q, f.contactId, f.to)
      if (!recipient.ok) return recipient
      const gate = approvalGate(address, at, sendAnyway)
      const addressOverride = gate.ok && gate.value.override !== 'none'
      const profileVersion = repo.latestProfileVersion(q)?.version ?? null
      const row = sendTransition(null, { type: 'approve', kind, followupId: f.id, messageId: newMessageId(at), addressOverride, profileVersion }, at) // T-S1
      if (!row.ok) return row
      const override = writeOverride(q, f.contactId, address, sendAnyway, at)
      if (!override.ok) return override
      return then(repo.saveFollowup(q, moved.value, { kind: 'approved', data: { kind } }, at, row.value), 'sending')
    })
  }

  /** Logs and never throws: a broken logger must not turn a send into an unobserved rejection. */
  function report(message: string, level: 'error' | 'warn' = 'error'): void {
    try {
      log[level](message)
    } catch {
      // The logger itself failed: there is nowhere left to say it, and the send's state is already decided.
    }
  }

  /** Everything step 2 does before SMTP: the message from the store, the password, the input. */
  async function prepare(id: string, kind: SendKind, signal: AbortSignal): Promise<Result<SendInput>> {
    const message = db.read((q) => outgoingFor(q, id, kind))
    if (!message.ok) return message
    const password = await deps.readPassword(deps.mail.passwordFile)
    if (!password.ok) return fail('blocked', password.reason)
    if (signal.aborted) return fail('conflict', STOPPING)
    return ok(inputFor(message.value, password.password, signal))
  }

  function inputFor(message: Outgoing, password: string, signal: AbortSignal): SendInput {
    const { address, displayName, smtpHost } = deps.mail
    return {
      host: smtpHost,
      user: address,
      password,
      from: { name: displayName, address },
      to: message.to,
      subject: message.subject,
      text: message.text,
      messageId: message.messageId,
      ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
      ...(message.references === undefined ? {} : { references: message.references }),
      ...(message.attachment === undefined ? {} : { attachment: { ...message.attachment, path: resolvePath(message.attachment.path) } }),
      timers: deps.timers,
      signal,
    }
  }

  /**
   * Step 2, never throwing. A throw BEFORE `sendMail` reached nothing on the wire: `before-data`
   * `internal-error` (the row `failed`, `send-failed`). A throw FROM `sendMail` may come after DATA:
   * `after-data` (the row `send-unknown`), never a failure that would invite a duplicate.
   * The log carries the error's name only: its message may quote the address or the body.
   */
  async function transmit(id: string, kind: SendKind, signal: AbortSignal): Promise<SendResult> {
    let input: Result<SendInput>
    try {
      input = await prepare(id, kind, signal)
    } catch (error) {
      report(`send ${id}/${kind}: ${faultOf(error)} before SMTP; the send failed (${INTERNAL_ERROR})`)
      return refused(INTERNAL_ERROR)
    }
    if (!input.ok) return refused(input.error.reason)
    try {
      return await deps.sendMail(input.value)
    } catch (error) {
      report(`send ${id}/${kind}: ${faultOf(error)} from SMTP; it may have gone out (send-unknown)`)
      return { ok: false, phase: 'after-data', reason: INTERNAL_ERROR }
    }
  }

  /**
   * After step 3 of the initial, in A SECOND `tx` (D9 step 2, revisión de E): the replies deferred while
   * it was `sending`. Its failure cannot undo the result already written; it is logged, recorded as an
   * event, and the replies stay pending for the next opening `tx` (`applyDeferredRepliesOnStart`).
   */
  function applyDeferredAfter(id: string, at: Date): void {
    const applied = db.tx((q) => applyDeferred(q, id, at))
    if (applied.ok) return
    report(`send ${id}/initial: the deferred replies were not applied (${applied.error.code} ${applied.error.reason}); they stay pending until the restart`)
    const recorded = db.tx((q) => {
      const companyId = repo.getApplication(q, id)?.companyId ?? null
      return ok(repo.appendEvent(q, { kind: 'deferred-replies-failed', data: { kind: 'initial', code: applied.error.code }, applicationId: id, companyId }, at))
    })
    if (!recorded.ok) report(`send ${id}/initial: the deferred-replies-failed event was not written (${recorded.error.code})`)
  }

  /** Step 3 in its own `tx`; for the initial, then the deferred replies in another. */
  function record(id: string, kind: SendKind, result: SendResult): void {
    const at = deps.now()
    const written = db.tx((q) => finish(q, id, kind, result, at))
    if (!written.ok) return report(`send ${id}/${kind}: step 3 was not written (${written.error.code} ${written.error.reason}); the row stays sending until the restart`)
    if (kind === 'initial') applyDeferredAfter(id, at)
  }

  /**
   * stop() (D9 step 5): step 3 is NOT written — the store is closing, and the next start makes the row
   * `send-unknown`, which asks the owner. What is known is logged instead: a mail SMTP accepted as the
   * abort landed carries its messageId and the server's response (our id and a queue id, no address), so
   * the owner's «It went» can be checked against the log.
   */
  function stoppedWith(id: string, kind: SendKind, result: SendResult): void {
    const tail = 'step 3 not written (stopping); the restart makes it send-unknown'
    if (result.ok) report(`send ${id}/${kind}: accepted by SMTP after stop, ${result.messageId} ${result.response}; ${tail}`, 'warn')
    else report(`send ${id}/${kind}: stopped mid-send (${result.phase}); ${tail}`, 'warn')
  }

  async function deliver(id: string, kind: SendKind, signal: AbortSignal): Promise<void> {
    const result = await transmit(id, kind, signal)
    if (signal.aborted) return stoppedWith(id, kind, result)
    record(id, kind, result)
  }

  function launch(id: string, kind: SendKind): boolean {
    if (stopped) {
      report(`send ${id}/${kind}: not launched, the sender is stopping; a row left sending becomes send-unknown at the restart`, 'warn')
      return false
    }
    const controller = new AbortController()
    const entry = {
      controller,
      done: deliver(id, kind, controller.signal)
        .catch((error: unknown) => report(`send ${id}/${kind}: ${faultOf(error)} after SMTP; the row stays sending until the restart`))
        .finally(() => inFlight.delete(entry)),
    }
    inFlight.add(entry)
    return true
  }

  async function settled(): Promise<void> {
    while (inFlight.size > 0) await Promise.all([...inFlight].map((entry) => entry.done))
  }

  return {
    approve: (id, kind, options = {}) => {
      if (stopped) return fail('conflict', 'the sender is stopping')
      const at = deps.now()
      const sendAnyway = options.addressOverride === true
      const begun = kind === 'initial' ? beginInitial(id, sendAnyway, at) : beginFollowup(id, kind, sendAnyway, at)
      if (!begun.ok) {
        return enqueueIfPending(db, deps.enqueueCheck, id, kind, begun)
      }
      if (begun.value === 'sending') launch(id, kind)
      return ok({ state: begun.value, kind })
    },
    launch,
    send: (id, kind) => {
      const row = db.read((q) => repo.getApplication(q, id)?.sends.find((s) => s.kind === kind))
      return row === undefined ? fail('not-found', `no ${kind} send for this application`) : ok(row)
    },
    settled,
    stop: async () => {
      stopped = true
      for (const entry of inFlight) entry.controller.abort(STOPPING)
      await settled()
    },
  }
}

/** The name of what was thrown, never its message (which may quote the address, the body or a path). */
const faultOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error)

const refused = (reason: string): SendResult => ({ ok: false, phase: 'before-data', reason })

type SmtpOutcome = { readonly type: 'smtp-accepted'; readonly response: string } | { readonly type: 'smtp-failed'; readonly reason: string } | { readonly type: 'smtp-unknown' }

const outcomeOf = (result: SendResult): SmtpOutcome =>
  result.ok
    ? { type: 'smtp-accepted', response: result.response }
    : result.phase === 'before-data'
      ? { type: 'smtp-failed', reason: result.reason }
      : { type: 'smtp-unknown' }

/** `sent { kind, messageId, response, addressOverride }` — the code and the queue id, never the body. */
function eventFor(kind: SendKind, row: Send | undefined, result: SendResult): repo.EventSpec {
  if (result.ok) return { kind: 'sent', data: { kind, messageId: row?.messageId ?? null, response: result.response, addressOverride: row?.addressOverride ?? false } }
  if (result.phase === 'before-data') return { kind: 'send-failed', data: { kind, reason: result.reason } }
  return { kind: 'send-unknown', data: { kind } }
}

/** Step 3, in its `tx` (T-S2/T-S3/T-S4 with T-A14…T-A16 or T-F8). */
function finish(q: Queries, id: string, kind: SendKind, result: SendResult, at: Date): Result<void> {
  const app = repo.getApplication(q, id)
  if (app === undefined) return fail('not-found', 'no such application')
  const outcome = outcomeOf(result)
  if (kind === 'initial') {
    const moved = appTransition(app, outcome, at)
    if (!moved.ok) return moved
    const row = moved.value.sends.find((s) => s.kind === 'initial')
    return repo.saveApplication(q, moved.value, eventFor(kind, row, result), at)
  }
  const row = app.sends.find((s) => s.kind === kind)
  const f = row?.followupId == null ? undefined : repo.getFollowup(q, row.followupId)
  if (row === undefined || f === undefined) return fail('conflict', 'the follow-up send has no row')
  const sendMoved = sendTransition(row, outcome, at)
  const fMoved = followupTransition(f, { type: outcome.type }, at)
  if (!sendMoved.ok) return sendMoved
  if (!fMoved.ok) return fMoved
  return repo.saveFollowup(q, fMoved.value, eventFor(kind, sendMoved.value, result), at, sendMoved.value)
}
