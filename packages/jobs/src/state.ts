/**
 * The single transition table of design D3, as four pure functions — the ONLY source of states.
 *
 * `(entity, event, now) → Result<entity>`. A transition not in the table is `conflict`; a guard that
 * needs the owner is `blocked`; the daily cap is `limit`. Each function returns a NEW object.
 *
 * WHAT THE TABLE NEEDS TO KNOW TRAVELS IN THE EVENT (the PDF on disk, the lint, the contact's
 * address, the cap): reading the disk or the store is the caller's, before; writing the result and
 * its event in one `tx` is the caller's, after (design D2).
 *
 * THE APPLICATION CARRIES ITS SENDS. The rows «Con» that write together (T-A11 with T-S1/T-S8,
 * T-A17 with T-S7, T-A30 with T-S11…) happen inside `appTransition`, which updates the `initial`
 * row (and, for a reply by rule 1, whichever row it proves). A follow-up's own row is moved by
 * `sendTransition` beside `followupTransition`.
 */

import { isSendableAddress } from './shape.ts'
import {
  fail,
  isManualChannel,
  ok,
  type Address,
  type Application,
  type AppState,
  type Channel,
  type Contact,
  type Followup,
  type FollowupState,
  type FollowupVersion,
  type Outcome,
  type Result,
  type Send,
  type SendKind,
  type Warning,
} from './types.ts'

/** v5 (X2): a check older than this is stale; approving waits for a new one. */
export const ADDRESS_STALE_DAYS = 14
const DAY_MS = 86_400_000

export type ReplyClass = 'interview' | 'asks-something' | 'offer' | 'rejection' | 'auto-ack' | 'other' | 'unrelated'
/** v6 (H1): only these change state; `auto-ack`, `other` and `unrelated` leave only their event. */
export const isHumanClass = (replyClass: ReplyClass): boolean =>
  replyClass === 'interview' || replyClass === 'asks-something' || replyClass === 'offer' || replyClass === 'rejection'

export interface DailyCap {
  readonly sentToday: number
  readonly maxPerDay: number
}

export type GeneratedKind = 'cv' | 'letter'

export type AppEvent =
  | { readonly type: 'enqueue' }
  | {
      readonly type: 'generation-returned'
      /** Another request of this application is still queued or running. */
      readonly pending: boolean
      /** The classes whose generation failed for the third time (T-A3). */
      readonly failed: readonly GeneratedKind[]
      /** The last reason of each failed class, when known: `NO_LETTER_YET` is said on its warning. */
      readonly reasons?: Readonly<Partial<Record<GeneratedKind, string>>>
      readonly pdfExists: boolean
      readonly warnings: readonly Warning[]
      readonly version: number
    }
  | { readonly type: 'retry-generation'; readonly kinds: readonly GeneratedKind[] }
  | { readonly type: 'instruction'; readonly hasLetter: boolean }
  | { readonly type: 'relint'; readonly pdfExists: boolean; readonly warnings: readonly Warning[] }
  | { readonly type: 'rewrite-returned'; readonly pdfExists: boolean; readonly warnings: readonly Warning[]; readonly version: number }
  | { readonly type: 'rewrite-failed' }
  | { readonly type: 'switch-to-form'; readonly url: string | null }
  | {
      readonly type: 'approve'
      readonly pdfExists: boolean
      /** The address of the target contact; null when there is no email. Ignored on manual channels. */
      readonly address: Address | null
      readonly sendAnyway: boolean
      readonly cap: DailyCap
      /** The messageId of this attempt (T-S1 or T-S8). */
      readonly messageId: string
      readonly profileVersion: number | null
    }
  | { readonly type: 'mark-sent' }
  | { readonly type: 'smtp-accepted'; readonly response: string }
  | { readonly type: 'smtp-failed'; readonly reason: string }
  | { readonly type: 'smtp-unknown' }
  | { readonly type: 'it-went' }
  | { readonly type: 'send-again'; readonly cap: DailyCap }
  | { readonly type: 'it-didnt-go' }
  | { readonly type: 'sent-by-hand' }
  | {
      readonly type: 'reply'
      readonly replyClass: ReplyClass
      /** D12: rule 1 matched a messageId; rules 2–3 matched the application. */
      readonly rule: 1 | 2 | 3
      readonly messageId: string | null
    }
  | { readonly type: 'close'; readonly reason: string; readonly outcome?: Outcome }
  | { readonly type: 'skip-not-a-fit'; readonly reason: string }
  | { readonly type: 'unapprove' }
  | { readonly type: 'add-event'; readonly kind: 'interview' | 'offer' | 'rejection' }

export type SendEvent =
  | {
      readonly type: 'approve'
      readonly kind: SendKind
      readonly followupId: string | null
      readonly messageId: string
      readonly addressOverride: boolean
      readonly profileVersion: number | null
      /** The version approved (`Send.artifactsVersion`). */
      readonly artifactsVersion: number
    }
  | { readonly type: 'mark-sent'; readonly kind: SendKind; readonly followupId: string | null }
  | { readonly type: 'smtp-accepted'; readonly response: string }
  | { readonly type: 'smtp-failed'; readonly reason: string }
  | { readonly type: 'smtp-unknown' }
  | { readonly type: 'it-went' }
  | { readonly type: 'send-again'; readonly cap: DailyCap }
  | { readonly type: 'reply'; readonly rule: 1 | 2 | 3; readonly messageId: string | null }
  | {
      readonly type: 'retry'
      readonly messageId: string
      readonly cap: DailyCap
      readonly addressOverride: boolean
      readonly profileVersion: number | null
      readonly artifactsVersion: number
    }
  | { readonly type: 'it-didnt-go'; readonly appState: AppState }

/** What a follow-up's guards need of its application. */
export interface AppContext {
  readonly state: AppState
  /** A matched reply of a human class exists (v6, H1). */
  readonly hasHumanReply: boolean
}

export type FollowupEvent =
  | { readonly type: 'relint'; readonly warnings: readonly Warning[] }
  | { readonly type: 'instruction' }
  | { readonly type: 'rewrite-returned'; readonly version: FollowupVersion; readonly warnings: readonly Warning[] }
  | { readonly type: 'rewrite-failed' }
  | {
      readonly type: 'approve'
      readonly app: AppContext
      readonly address: Address | null
      readonly sendAnyway: boolean
      readonly cap: DailyCap
    }
  | { readonly type: 'mark-sent' }
  | { readonly type: 'smtp-accepted' }
  | { readonly type: 'smtp-failed' }
  | { readonly type: 'smtp-unknown' }
  | { readonly type: 'it-went' }
  /** Rule 1 of D12 matched THIS follow-up's send (T-F9, T-F14). */
  | { readonly type: 'reply' }
  | { readonly type: 'send-again'; readonly app: AppContext; readonly cap: DailyCap }
  | { readonly type: 'retry'; readonly cap: DailyCap }
  | { readonly type: 'cancel'; readonly why: string }
  | { readonly type: 'skip-not-a-fit' }
  | { readonly type: 'it-didnt-go'; readonly app: AppContext }
  | {
      readonly type: 'switch-channel'
      readonly to: 'email' | 'linkedin'
      /** The contact's email, for a switch to email. */
      readonly email: string | null
      readonly version: FollowupVersion
      readonly warnings: readonly Warning[]
    }

export type AddressEvent =
  | { readonly type: 'create'; readonly email: string; readonly seen: { readonly url: string } | null }
  | { readonly type: 'enqueue-check' }
  | { readonly type: 'check-found'; readonly url: string }
  | { readonly type: 'check-missed'; readonly timedOut?: boolean }
  | { readonly type: 'send-anyway' }
  | { readonly type: 'restart' }
  | { readonly type: 'edit'; readonly email: string }

// ── Shared pieces ────────────────────────────────────────────────────────────────────────────────

const notInTable = <T>(event: string, from: string): Result<T> => fail('conflict', `${event} is not a transition from ${from}`)

/** A block the owner has not overridden. */
export const hasBlock = (warnings: readonly Warning[]): boolean => warnings.some((w) => w.blocks && w.overridden === null)

const overCap = (cap: DailyCap): boolean => cap.sentToday >= cap.maxPerDay
const capReached = <T>(): Result<T> => fail('limit', 'daily-cap')

/** Stale: never checked, or checked more than `ADDRESS_STALE_DAYS` ago (v5, X2). */
export function isStaleCheck(address: Address, now: Date): boolean {
  if (address.checkedAt === null) return true
  return now.getTime() - new Date(address.checkedAt).getTime() > ADDRESS_STALE_DAYS * DAY_MS
}

export interface Gate {
  /** `existing`: the contact's override serves; `new`: «Send anyway» writes it now (T-D5). */
  readonly override: 'none' | 'existing' | 'new'
}

/**
 * «Qué responde el motor al aprobar, según la dirección» (v5, X4) — the same table for «Approve» and
 * «Send anyway», in T-A11, T-F6 and T-D5. `check-pending` is a conflict (try again in a moment);
 * `address-unverified` is blocked (the owner decides).
 */
export function approvalGate(address: Address | null, now: Date, sendAnyway: boolean): Result<Gate> {
  if (address === null) return fail('blocked', 'no-address')
  if (address.status === 'checking' || isStaleCheck(address, now)) return fail('conflict', 'check-pending')
  if (address.status === 'verified') return ok({ override: 'none' })
  if (address.override !== null) return ok({ override: 'existing' })
  return sendAnyway ? ok({ override: 'new' }) : fail('blocked', 'address-unverified')
}

export interface SendMatch {
  readonly send: Send
  /** The messageId was an earlier `failed` attempt of this row (v6.1). */
  readonly viaAttempt: boolean
}

/** D12 rule 1: the row whose messageId, or one of whose attempts, is `messageId`. */
export function matchSend(sends: readonly Send[], messageId: string | null): SendMatch | null {
  if (messageId === null) return null
  for (const send of sends) {
    if (send.messageId === messageId) return { send, viaAttempt: false }
    if (send.attempts.some((attempt) => attempt.messageId === messageId)) return { send, viaAttempt: true }
  }
  return null
}

// ── Send ─────────────────────────────────────────────────────────────────────────────────────────

const newSend = (kind: SendKind, followupId: string | null, at: string): Send => ({
  kind,
  followupId,
  channel: 'smtp',
  messageId: null,
  state: 'sending',
  at,
  response: null,
  reason: null,
  addressOverride: false,
  profileVersion: null,
  artifactsVersion: null,
  attempts: [],
})

const provedBy = (send: Send, rule: 1 | 2 | 3, messageId: string | null): boolean =>
  rule === 1 ? matchSend([send], messageId) !== null : send.kind === 'initial'

function createSend(event: SendEvent, at: string): Result<Send> {
  if (event.type === 'approve') {
    return ok({
      ...newSend(event.kind, event.followupId, at),
      messageId: event.messageId,
      addressOverride: event.addressOverride,
      profileVersion: event.profileVersion,
      artifactsVersion: event.artifactsVersion,
    })
  }
  if (event.type === 'mark-sent') return ok({ ...newSend(event.kind, event.followupId, at), channel: 'manual', state: 'sent' })
  return notInTable(event.type, 'no row')
}

/** The table's «Envío» rows, T-S1…T-S11. `null` is a row that does not exist yet. */
export function sendTransition(send: Send | null, event: SendEvent, now: Date): Result<Send> {
  const at = now.toISOString()
  if (send === null) return createSend(event, at)
  const to = (patch: Partial<Send>): Result<Send> => ok({ ...send, at, ...patch })
  switch (`${send.state}:${event.type}`) {
    case 'sending:smtp-accepted':
      return to({ state: 'sent', response: event.type === 'smtp-accepted' ? event.response : null }) // T-S2
    case 'sending:smtp-failed':
      return to({ state: 'failed', reason: event.type === 'smtp-failed' ? event.reason : null }) // T-S3
    case 'sending:smtp-unknown':
      return to({ state: 'send-unknown' }) // T-S4
    case 'send-unknown:it-went':
      return to({ state: 'sent' }) // T-S5
    case 'send-unknown:send-again':
      return event.type === 'send-again' && overCap(event.cap) ? capReached() : to({ state: 'sending' }) // T-S6
    case 'send-unknown:reply':
    case 'failed:reply':
      return replyOnSend(send, event, to) // T-S7, T-S11
    case 'failed:retry':
      return event.type === 'retry' ? retrySend(send, event, at) : notInTable(event.type, send.state) // T-S8
    case 'send-unknown:it-didnt-go': {
      // T-S10: the initial, or a follow-up whose application already has a reply or is closed.
      const appState = event.type === 'it-didnt-go' ? event.appState : 'sent'
      const allowed = send.kind === 'initial' || appState === 'replied' || appState === 'closed'
      return allowed ? to({ state: 'failed', reason: 'owner-not-sent' }) : notInTable('it-didnt-go of a follow-up', 'an unanswered application')
    }
    default:
      return notInTable(event.type, send.state)
  }
}

function replyOnSend(send: Send, event: SendEvent, to: (patch: Partial<Send>) => Result<Send>): Result<Send> {
  if (event.type !== 'reply') return notInTable(event.type, send.state)
  // T-S11 is only by rule 1; T-S7 also by rules 2–3, and then only for the initial.
  if (send.state === 'failed' && event.rule !== 1) return notInTable('a reply by rule 2–3', 'failed')
  if (!provedBy(send, event.rule, event.messageId)) return fail('conflict', 'the reply does not prove this send')
  return to({ state: 'sent', reason: null })
}

function retrySend(send: Send, event: Extract<SendEvent, { type: 'retry' }>, at: string): Result<Send> {
  if (overCap(event.cap)) return capReached()
  const previous = send.messageId === null ? [] : [{ messageId: send.messageId, at: send.at, reason: send.reason }]
  return ok({
    ...send,
    state: 'sending',
    at,
    messageId: event.messageId,
    response: null,
    reason: null,
    addressOverride: event.addressOverride,
    profileVersion: event.profileVersion,
    artifactsVersion: event.artifactsVersion,
    attempts: [...send.attempts, ...previous],
  })
}

// ── Application ──────────────────────────────────────────────────────────────────────────────────

export interface NewApplication {
  readonly id: string
  readonly opportunityId: string
  readonly companyId: string
  readonly channel: Channel
  readonly target: Application['target']
  readonly cvBase: Application['cvBase']
  readonly holdUntil: string | null
  readonly notes: string
  readonly test: boolean
}

/** Every application is born `draft` (seed, scout, «Draft outreach», T-A32). */
export function newApplication(input: NewApplication, now: Date): Application {
  const at = now.toISOString()
  return { ...input, state: 'draft', outcome: null, rewriteFrom: null, version: 0, sends: [], warnings: [], createdAt: at, updatedAt: at }
}

const BEFORE_SENDING: readonly AppState[] = ['draft', 'generating', 'in-review', 'ready', 'rewriting', 'approved']
const REVIEWED: readonly AppState[] = ['in-review', 'ready']
const initialOf = (app: Application): Send | undefined => app.sends.find((s) => s.kind === 'initial')
const ORDER: Readonly<Record<SendKind, number>> = { initial: 0, 'followup-1': 1, 'followup-2': 2 }

function withSend(app: Application, send: Send): Application {
  const others = app.sends.filter((s) => s.kind !== send.kind)
  return { ...app, sends: [...others, send].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]) }
}

/** D6 «Re-lint»: the warnings no linter makes, which a re-lint keeps (with their `overridden`). */
const KEPT_BY_RELINT: ReadonlySet<Warning['code']> = new Set<Warning['code']>(['unsupported-claim', 'cv-overflow', 'ad-closed', 'requirement-gap'])

const sameWarning = (a: Warning, b: Warning): boolean => a.code === b.code && a.where === b.where && a.detail === b.detail

/**
 * What a re-lint leaves (D6 «Re-lint»): the linter's warnings, each keeping an «I checked it» the same
 * warning already had (the same link still there); then the found warnings it does not repeat. Pure.
 * A caller that passes the whole list (an override, the ad's closing) loses nothing: the same warning
 * is never kept twice.
 */
export function relintedWarnings(previous: readonly Warning[], linted: readonly Warning[]): readonly Warning[] {
  const carried = linted.map((w) => (w.overridden !== null ? w : { ...w, overridden: previous.find((p) => p.overridden !== null && sameWarning(p, w))?.overridden ?? null }))
  const kept = previous.filter((p) => KEPT_BY_RELINT.has(p.code) && !carried.some((w) => sameWarning(w, p)))
  return [...carried, ...kept]
}

/** Ready needs the CV printed and no block left; anything else reviewed is in-review. */
const reviewedState = (pdfExists: boolean, warnings: readonly Warning[]): AppState => (pdfExists && !hasBlock(warnings) ? 'ready' : 'in-review')

/** Until T1 writes `draftOutreach`, nothing generates a letter: a `letter` work fails with this (§M). */
export const NO_LETTER_YET = 'letter generation arrives with T1'

/** The class's warning; a letter that failed because nothing generates letters yet says so, so the card explains itself. */
function missingWarning(kind: GeneratedKind, reason: string | undefined): Warning {
  const detail = kind === 'letter' && reason === NO_LETTER_YET ? NO_LETTER_YET : `the ${kind} generation failed`
  return { code: kind === 'cv' ? 'missing-cv' : 'missing-letter', where: kind, detail, blocks: true, overridden: null }
}

const MISSING_CODE: Readonly<Record<GeneratedKind, Warning['code']>> = { cv: 'missing-cv', letter: 'missing-letter' }

type Step = (app: Application) => Result<Application>

/** Moves the initial row with `sendTransition` and the application with `patch`, together. */
function withInitial(app: Application, event: SendEvent, now: Date, patch: Partial<Application>): Result<Application> {
  const initial = initialOf(app)
  if (initial === undefined) return fail('conflict', 'there is no initial send')
  const moved = sendTransition(initial, event, now)
  return moved.ok ? ok({ ...withSend(app, moved.value), ...patch }) : moved
}

function generationReturned(app: Application, event: Extract<AppEvent, { type: 'generation-returned' }>): Result<Application> {
  if (app.state !== 'generating') return notInTable(event.type, app.state)
  if (event.pending) return fail('conflict', 'requests-pending')
  if (event.failed.length > 0) {
    // T-A3: in-review with the warning of the class that failed (v5, X8); what came back is kept.
    const codes = new Set(event.failed.map((kind) => MISSING_CODE[kind]))
    const kept = event.warnings.filter((w) => !codes.has(w.code))
    return ok({ ...app, state: 'in-review', version: event.version, warnings: [...kept, ...event.failed.map((kind) => missingWarning(kind, event.reasons?.[kind]))] })
  }
  return ok({ ...app, state: reviewedState(event.pdfExists, event.warnings), version: event.version, warnings: event.warnings }) // T-A2
}

function instruction(app: Application, hasLetter: boolean): Result<Application> {
  if (!REVIEWED.includes(app.state)) return notInTable('instruction', app.state)
  if (hasLetter) return ok({ ...app, state: 'rewriting', rewriteFrom: app.state === 'ready' ? 'ready' : 'in-review' }) // T-A7
  // T-A4 (v6, M9): no letter to rewrite — a new generation with the instruction in its prompt.
  return app.state === 'in-review' ? ok({ ...app, state: 'generating' }) : notInTable('instruction without a letter', app.state)
}

function approve(app: Application, event: Extract<AppEvent, { type: 'approve' }>, now: Date): Result<Application> {
  if (app.state !== 'ready') return notInTable('approve', app.state)
  if (!event.pdfExists) return fail('blocked', 'missing-cv')
  if (hasBlock(app.warnings)) return fail('blocked', 'lint-blocks')
  if (isManualChannel(app.channel)) return ok({ ...app, state: 'approved' }) // T-A12
  const gate = approvalGate(event.address, now, event.sendAnyway)
  if (!gate.ok) return gate
  if (overCap(event.cap)) return capReached()
  const addressOverride = gate.value.override !== 'none'
  const initial = initialOf(app)
  // D9 (revisión del corte 1a): the row pins the version approved, the application's current one.
  const pinned = { addressOverride, profileVersion: event.profileVersion, artifactsVersion: app.version }
  // v6 (M1): the EXISTENCE of the row decides — T-S1 without one, T-S8 on a failed one, whatever the button.
  const moved =
    initial === undefined
      ? sendTransition(null, { type: 'approve', kind: 'initial', followupId: null, messageId: event.messageId, ...pinned }, now)
      : sendTransition(initial, { type: 'retry', messageId: event.messageId, cap: event.cap, ...pinned }, now)
  if (!moved.ok) return initial !== undefined && initial.state !== 'failed' ? fail('conflict', 'the initial was already sent') : moved
  return ok({ ...withSend(app, moved.value), state: 'sending' }) // T-A11
}

/** T-A13 and T-A19: a manual initial row, `sent`. A failed SMTP row before it keeps its id in `attempts`. */
function sentByHand(app: Application, now: Date): Result<Application> {
  const manual = sendTransition(null, { type: 'mark-sent', kind: 'initial', followupId: null }, now)
  if (!manual.ok) return manual
  const failed = initialOf(app)
  const attempts =
    failed === undefined || failed.messageId === null ? [] : [...failed.attempts, { messageId: failed.messageId, at: failed.at, reason: failed.reason }]
  return ok({ ...withSend(app, { ...manual.value, attempts }), state: 'sent', rewriteFrom: null })
}

function close(app: Application, event: Extract<AppEvent, { type: 'close' }>): Result<Application> {
  if (event.reason.trim() === '') return fail('invalid', 'a close needs a reason', 'reason')
  if (BEFORE_SENDING.includes(app.state)) return ok({ ...app, state: 'closed', outcome: 'dropped', rewriteFrom: null }) // T-A26
  if (app.state === 'sent' || app.state === 'replied') {
    return ok({ ...app, state: 'closed', outcome: event.outcome ?? app.outcome ?? 'dropped' }) // T-A21
  }
  return notInTable('close', app.state)
}

/** The row of the class, on an application already `sent`, `replied` or `closed` (T-A20…T-A25, T-A29). */
function classRow(app: Application, replyClass: ReplyClass): Result<Application> {
  if (app.state !== 'sent' && app.state !== 'replied' && app.state !== 'closed') return fail('conflict', `a reply does not apply to ${app.state}`)
  if (!isHumanClass(replyClass)) return ok(app) // T-A29
  if (replyClass === 'rejection') return ok({ ...app, state: 'closed', outcome: 'rejected' }) // T-A21, T-A25
  const named: Outcome | null = replyClass === 'interview' || replyClass === 'offer' ? replyClass : null
  if (app.state === 'closed') return ok({ ...app, state: 'replied', outcome: named }) // T-A24
  return ok({ ...app, state: 'replied', outcome: named ?? app.outcome }) // T-A20, T-A23
}

/** The send a reply proves: rule 1 by messageId or attempts, rules 2–3 only the initial. */
function provedSend(app: Application, event: Extract<AppEvent, { type: 'reply' }>): Send | undefined {
  if (event.rule === 1) return matchSend(app.sends, event.messageId)?.send
  return initialOf(app)
}

function reply(app: Application, event: Extract<AppEvent, { type: 'reply' }>, now: Date): Result<Application> {
  // v6.1: with the initial in flight, only the event is written; the close of the send applies it.
  if (app.state === 'sending') return ok(app)
  const proved = provedSend(app, event)
  if (event.rule === 1 && proved === undefined) return fail('conflict', 'the reply matches no send of this application')
  let next = app
  if (proved !== undefined && (proved.state === 'send-unknown' || proved.state === 'failed')) {
    const moved = sendTransition(proved, { type: 'reply', rule: event.rule, messageId: event.messageId }, now) // T-S7, T-S11
    if (!moved.ok) return moved
    next = withSend(app, moved.value)
    if (proved.kind === 'initial' && app.state === 'send-unknown') next = { ...next, state: 'sent' } // T-A17
    if (proved.kind === 'initial' && BEFORE_SENDING.includes(app.state)) next = { ...next, state: 'sent', rewriteFrom: null } // T-A30
  }
  return classRow(next, event.replyClass)
}

function addEvent(app: Application, kind: 'interview' | 'offer' | 'rejection'): Result<Application> {
  if (app.state !== 'sent' && app.state !== 'replied' && app.state !== 'closed') return notInTable(`add-event ${kind}`, app.state)
  if (kind === 'rejection') return ok({ ...app, state: 'closed', outcome: 'rejected' })
  return ok({ ...app, state: 'replied', outcome: kind }) // T-A28
}

function stepFor(event: AppEvent, now: Date): Step {
  const only =
    (states: readonly AppState[], step: Step): Step =>
    (app) =>
      states.includes(app.state) ? step(app) : notInTable(event.type, app.state)
  switch (event.type) {
    case 'enqueue':
      return only(['draft'], (app) => ok({ ...app, state: 'generating' })) // T-A1
    case 'generation-returned':
      return (app) => generationReturned(app, event)
    case 'retry-generation':
      return only(['in-review'], (app) => {
        const codes = new Set(event.kinds.map((kind) => MISSING_CODE[kind]))
        return ok({ ...app, state: 'generating', warnings: app.warnings.filter((w) => !codes.has(w.code)) }) // T-A4
      })
    case 'instruction':
      return (app) => instruction(app, event.hasLetter)
    case 'relint':
      return only(REVIEWED, (app) => {
        const warnings = relintedWarnings(app.warnings, event.warnings)
        return ok({ ...app, state: reviewedState(event.pdfExists, warnings), warnings }) // T-A5, T-A6
      })
    case 'rewrite-returned':
      return only(['rewriting'], (app) =>
        ok({ ...app, state: reviewedState(event.pdfExists, event.warnings), warnings: event.warnings, version: event.version, rewriteFrom: null }),
      ) // T-A8
    case 'rewrite-failed':
      return only(['rewriting'], (app) => ok({ ...app, state: app.rewriteFrom ?? 'in-review', rewriteFrom: null })) // T-A9
    case 'switch-to-form':
      return only(REVIEWED, (app) => {
        if (app.channel !== 'email') return fail('conflict', 'only an email switches to a form')
        if (event.url === null) return fail('conflict', 'no-form-url')
        return ok({ ...app, channel: 'form', target: { ...app.target, url: event.url } }) // T-A10
      })
    case 'approve':
      return (app) => approve(app, event, now)
    case 'mark-sent':
      return only(['approved'], (app) => sentByHand(app, now)) // T-A13
    case 'smtp-accepted':
      return only(['sending'], (app) => withInitial(app, event, now, { state: 'sent' })) // T-A14
    case 'smtp-failed':
      return only(['sending'], (app) => withInitial(app, event, now, { state: 'ready' })) // T-A15
    case 'smtp-unknown':
      return only(['sending'], (app) => withInitial(app, event, now, { state: 'send-unknown' })) // T-A16
    case 'it-went':
      return only(['send-unknown'], (app) => withInitial(app, event, now, { state: 'sent' })) // T-A17
    case 'send-again':
      return only(['send-unknown'], (app) => withInitial(app, event, now, { state: 'sending' })) // T-A18
    case 'it-didnt-go':
      return only(['send-unknown'], (app) => withInitial(app, { type: 'it-didnt-go', appState: app.state }, now, { state: 'ready' })) // T-A31
    case 'sent-by-hand':
      return only(BEFORE_SENDING, (app) => (app.sends.length > 0 ? fail('conflict', 'it already has a send') : sentByHand(app, now))) // T-A19
    case 'reply':
      return (app) => reply(app, event, now)
    case 'close':
      return (app) => close(app, event)
    case 'skip-not-a-fit':
      return only(REVIEWED, (app) => ok({ ...app, state: 'closed', outcome: 'dropped' })) // T-A22
    case 'unapprove':
      return only(['approved'], (app) => (app.sends.length > 0 ? fail('conflict', 'it already has a send') : ok({ ...app, state: 'ready' }))) // T-A27
    case 'add-event':
      return (app) => addEvent(app, event.kind)
  }
}

/** The table's «Postulación» rows, T-A1…T-A32. */
export function appTransition(app: Application, event: AppEvent, now: Date): Result<Application> {
  const moved = stepFor(event, now)(app)
  if (!moved.ok || moved.value === app) return moved
  return ok({ ...moved.value, updatedAt: now.toISOString() })
}

// ── Follow-up ────────────────────────────────────────────────────────────────────────────────────

export interface NewFollowup {
  readonly id: string
  readonly applicationId: string
  readonly n: 1 | 2
  readonly channel: Followup['channel']
  readonly contactId: string | null
  readonly to: string | null
  readonly version: FollowupVersion
  readonly warnings: readonly Warning[]
}

const lintedState = (warnings: readonly Warning[]): FollowupState => (hasBlock(warnings) ? 'draft' : 'ready')

/** T-F1: `followupDue` gave `n` and there is no follow-up `n` of that application yet. */
export function newFollowup(input: NewFollowup, existing: readonly Followup[], now: Date): Result<Followup> {
  if (existing.some((f) => f.applicationId === input.applicationId && f.n === input.n)) return fail('conflict', `follow-up ${input.n} already exists`)
  const at = now.toISOString()
  const { version, ...rest } = input
  return ok({ ...rest, state: lintedState(input.warnings), rewriteFrom: null, version: version.version, versions: [version], createdAt: at, updatedAt: at })
}

/** A follow-up is sent only while its application is `sent` with no human reply (T-F6, T-F9). */
const stillUnanswered = (app: AppContext): boolean => app.state === 'sent' && !app.hasHumanReply

function approveFollowup(row: Followup, event: Extract<FollowupEvent, { type: 'approve' }>, now: Date): Result<Followup> {
  if (row.channel !== 'email') return fail('conflict', 'a LinkedIn note is marked as sent, not approved')
  if (!stillUnanswered(event.app)) return fail('conflict', 'the application already has a reply or is closed')
  const gate = approvalGate(event.address, now, event.sendAnyway)
  if (!gate.ok) return gate
  return overCap(event.cap) ? capReached() : ok({ ...row, state: 'sending' }) // T-F6
}

function switchChannel(row: Followup, event: Extract<FollowupEvent, { type: 'switch-channel' }>): Result<Followup> {
  if (event.to === row.channel) return fail('conflict', `the follow-up is already ${row.channel}`)
  if (event.to === 'email' && (event.email === null || !isSendableAddress(event.email))) return fail('conflict', 'the contact has no email')
  return ok({
    ...row,
    channel: event.to,
    to: event.to === 'email' ? event.email : null,
    version: event.version.version,
    versions: [...row.versions, event.version],
    warnings: event.warnings,
    state: lintedState(event.warnings),
  }) // T-F15
}

type FollowupStep = (row: Followup) => Result<Followup>

function followupStepFor(event: FollowupEvent, now: Date): FollowupStep {
  const only =
    (states: readonly FollowupState[], step: FollowupStep): FollowupStep =>
    (row) =>
      states.includes(row.state) ? step(row) : notInTable(event.type, row.state)
  const toState = (state: FollowupState): FollowupStep => (row) => ok({ ...row, state })
  const capped = (cap: DailyCap): FollowupStep => (row) => (overCap(cap) ? capReached() : ok({ ...row, state: 'sending' }))
  switch (event.type) {
    case 'relint':
      return only(['draft', 'ready'], (row) => ok({ ...row, warnings: event.warnings, state: lintedState(event.warnings) })) // T-F2
    case 'instruction':
      return only(['draft', 'ready'], (row) => ok({ ...row, state: 'rewriting', rewriteFrom: row.state === 'ready' ? 'ready' : 'draft' })) // T-F3
    case 'rewrite-returned':
      return only(['rewriting'], (row) =>
        ok({
          ...row,
          state: lintedState(event.warnings),
          warnings: event.warnings,
          version: event.version.version,
          versions: [...row.versions, event.version],
          rewriteFrom: null,
        }),
      ) // T-F4
    case 'rewrite-failed':
      return only(['rewriting'], (row) => ok({ ...row, state: row.rewriteFrom ?? 'draft', rewriteFrom: null })) // T-F5
    case 'approve':
      return only(['ready'], (row) => approveFollowup(row, event, now))
    case 'mark-sent':
      return only(['ready'], (row) => (row.channel === 'linkedin' ? ok({ ...row, state: 'sent' }) : fail('conflict', 'an email follow-up is sent by SMTP'))) // T-F7
    case 'smtp-accepted':
      return only(['sending'], toState('sent')) // T-F8
    case 'smtp-failed':
      return only(['sending'], toState('failed')) // T-F8
    case 'smtp-unknown':
      return only(['sending'], toState('send-unknown')) // T-F8
    case 'it-went':
      return only(['send-unknown'], toState('sent')) // T-F9
    case 'reply':
      return (row) => {
        if (row.state === 'send-unknown' || row.state === 'failed') return ok({ ...row, state: 'sent' }) // T-F9, T-F14
        return row.state === 'sent' || row.state === 'sending' ? ok(row) : notInTable('reply', row.state)
      }
    case 'send-again':
      return only(['send-unknown'], (row) => (stillUnanswered(event.app) ? capped(event.cap)(row) : fail('conflict', 'the application already has a reply or is closed'))) // T-F9
    case 'retry':
      return only(['failed'], capped(event.cap)) // T-F10
    case 'cancel':
      return only(['draft', 'ready', 'rewriting', 'failed'], (row) => ok({ ...row, state: 'cancelled', rewriteFrom: null })) // T-F11
    case 'skip-not-a-fit':
      return only(['draft', 'ready'], toState('cancelled')) // T-F12
    case 'it-didnt-go':
      return only(['send-unknown'], (row) =>
        event.app.state === 'replied' || event.app.state === 'closed' ? ok({ ...row, state: 'cancelled' }) : fail('conflict', 'the application is still unanswered'),
      ) // T-F13
    case 'switch-channel':
      return only(['draft', 'ready'], (row) => switchChannel(row, event))
  }
}

/** The table's «Seguimiento» rows, T-F2…T-F15 (T-F1 is `newFollowup`). */
export function followupTransition(row: Followup, event: FollowupEvent, now: Date): Result<Followup> {
  const moved = followupStepFor(event, now)(row)
  if (!moved.ok || moved.value === row) return moved
  return ok({ ...moved.value, updatedAt: now.toISOString() })
}

// ── Address ──────────────────────────────────────────────────────────────────────────────────────

const unverified = (checkedAt: string | null, override: Address['override']): Address => ({ status: 'unverified', verifiedUrl: null, checkedAt, override })

function onAddress(contact: Contact, event: AddressEvent, now: Date, address: Address): Result<Contact> {
  const at = now.toISOString()
  const set = (next: Address): Result<Contact> => ok({ ...contact, address: next })
  switch (event.type) {
    case 'enqueue-check': {
      // T-D2: from verified only when stale.
      const allowed = address.status === 'unverified' || (address.status === 'verified' && isStaleCheck(address, now))
      return allowed ? set({ ...address, status: 'checking' }) : notInTable('enqueue-check', address.status)
    }
    case 'check-found':
      return address.status === 'checking' ? set({ ...address, status: 'verified', verifiedUrl: event.url, checkedAt: at }) : notInTable(event.type, address.status) // T-D3
    case 'check-missed':
      // T-D4: `verifiedUrl` is where it was SEEN (D3); a re-check of a stale `verified` that misses
      // leaves nothing seen, so the old url goes, like T-D6/T-D7. The override stays (D3: T-D2…T-D4).
      return address.status === 'checking' ? set(unverified(at, address.override)) : notInTable(event.type, address.status)
    case 'send-anyway': {
      // T-D5: never in checking, only after a finished, fresh check.
      if (address.status !== 'unverified') return notInTable(event.type, address.status)
      return isStaleCheck(address, now) ? fail('conflict', 'check-pending') : set({ ...address, override: { at } })
    }
    case 'restart':
      return address.status === 'checking' ? set(unverified(null, address.override)) : notInTable(event.type, address.status) // T-D6
    default:
      return notInTable(event.type, address.status)
  }
}

/** The table's «Dirección» rows, T-D1…T-D7, on the contact that owns the address (A2). */
export function addressTransition(contact: Contact, event: AddressEvent, now: Date): Result<Contact> {
  if (event.type === 'create' || event.type === 'edit') {
    if (!isSendableAddress(event.email)) return fail('invalid', 'not an email address', 'email')
    if (event.type === 'create') {
      if (contact.address !== null) return fail('conflict', 'the contact already has an address')
      const seen = event.seen
      const address: Address = seen === null ? unverified(null, null) : { status: 'verified', verifiedUrl: seen.url, checkedAt: null, override: null }
      return ok({ ...contact, email: event.email, address }) // T-D1
    }
    if (contact.address?.status === 'checking') return notInTable('edit', 'checking')
    return ok({ ...contact, email: event.email, address: unverified(null, null) }) // T-D7
  }
  if (contact.address === null) return notInTable(event.type, 'no address')
  return onAddress(contact, event, now, contact.address)
}
