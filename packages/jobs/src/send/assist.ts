/**
 * The assistance panel's actions (design D9, task E3): «It went», «Send again», «It didn't go»,
 * «Retry» and «Mark as sent». Each takes the `kind` and acts on THAT row of `sends`.
 *
 * «Send again» and «Retry» go back to step 1 (with the cap) and on to 2–3 through the sender:
 * «Send again» keeps the `messageId` (T-S6: that one may have gone out); «Retry» of a `failed` row
 * UPDATEs the same row with a new one, the old to `attempts` (T-S8). For the initial, «Retry» IS the
 * approval (T-A11 + T-S8, with every check of step 1: v6 M1).
 *
 * Both send THE VERSION THE ROW PINNED at its approval (D9, revisión del corte 1a): when the
 * application (or the follow-up) has another one now, they answer `blocked stale-version` and move
 * nothing — what was approved is not what would go; only «Approve» of what the screen shows sends it.
 *
 * A FOLLOW-UP ROW moves through `moveFollowup` (T-F7, T-F9, T-F10, T-F13), the step F2b connects like
 * B6's `afterSave`; by default it is the bare `followupTransition`.
 */

import { appTransition, followupTransition, sendTransition, type AppEvent, type FollowupEvent, type SendEvent } from '../state.ts'
import type { Db, Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { fail, ok, type Application, type Followup, type Result, type Send, type SendKind, type SendState } from '../types.ts'
import { hasHumanReply } from './deferred.ts'
import { pinnedVersion } from './message.ts'
import { addressGuard } from './recipient.ts'
import { dailyCap, enqueueIfPending, followupOf, newMessageId, writeOverride, type ApproveOptions, type Enqueue, type Sender } from './send.ts'

export type UnknownAnswer = 'went' | 'again' | 'not-went'

/** Moves a follow-up with the event of its row; F2b connects its own. */
export type MoveFollowup = (q: Queries, followup: Followup, event: FollowupEvent, now: Date) => Result<Followup>

export interface AssistDeps {
  readonly db: Db
  readonly now: () => Date
  readonly timeZone: string
  readonly maxSendsPerDay: number
  readonly sender: Pick<Sender, 'approve' | 'launch'>
  /** N4's `enqueueCheck`: «Send again» and «Retry» answer `check-pending` like «Approve» (X4). */
  readonly enqueueCheck: Enqueue
  readonly moveFollowup?: MoveFollowup
}

/**
 * The row as the screen saw it (D15 «Lo que se vio es lo que se aprueba»): its `state` and its `at`.
 * An answer that carries one is refused `conflict 'stale'`, deciding nothing, when the row has moved
 * since — another device answered it, or a send finished — so a stale card never sends a copy more.
 */
export interface SendExpect {
  readonly state: SendState
  readonly at: string
}

export interface AnswerOptions extends ApproveOptions {
  readonly expect?: SendExpect
}

export interface Assist {
  /** `options.addressOverride` is «Send anyway» for «Send again» and «Retry», as in `approve`; `options.expect`, the row the screen saw. */
  readonly resolveUnknown: (id: string, kind: SendKind, answer: UnknownAnswer, options?: AnswerOptions) => Result<Send>
  readonly retrySend: (id: string, kind: SendKind, options?: AnswerOptions) => Result<Send>
  readonly markSent: (id: string, kind: SendKind) => Result<Application>
}

const rowOf = (app: Application, kind: SendKind): Result<Send> => {
  const row = app.sends.find((s) => s.kind === kind)
  return row === undefined ? fail('conflict', `there is no ${kind} send`) : ok(row)
}

/** `stale-version` when `kind`'s row pins another version than `current` (D9, revisión del corte 1a); ok without a row (its conflict comes later). */
function sameVersion(app: Application, kind: SendKind, current: number): Result<unknown> {
  const row = app.sends.find((s) => s.kind === kind)
  return row === undefined ? ok(undefined) : pinnedVersion(row, current)
}

/** The same for a follow-up, read inside the caller's `tx`. */
function sameFollowupVersion(q: Queries, f: Followup, kind: SendKind): Result<unknown> {
  const app = repo.getApplication(q, f.applicationId)
  return app === undefined ? fail('not-found', 'no such application') : sameVersion(app, kind, f.version)
}

/** `conflict 'stale'` when the screen saw `kind`'s row in another state or at another moment; ok without `expect`. */
function fresh(app: Application, kind: SendKind, expect: SendExpect | undefined): Result<true> {
  if (expect === undefined) return ok(true)
  const row = app.sends.find((s) => s.kind === kind)
  return row !== undefined && row.state === expect.state && row.at === expect.at ? ok(true) : fail('conflict', 'stale')
}

/** What the initial's actions write: the application event (T-A13/T-A17/T-A18/T-A31) and its log line. */
interface InitialStep {
  readonly event: AppEvent
  readonly log: (row: Send) => repo.EventSpec
}

/** What a follow-up's actions write: its event, its row's event, and the log line. */
interface FollowupStep {
  readonly followup: (app: Application) => FollowupEvent
  readonly send: (row: Send | null, followup: Followup) => SendEvent
  readonly log: (row: Send) => repo.EventSpec
}

export function createAssist(deps: AssistDeps): Assist {
  const { db } = deps
  const move: MoveFollowup = deps.moveFollowup ?? ((_q, f, event, now) => followupTransition(f, event, now))
  const capOf = (q: Queries, at: Date) => dailyCap(q, at, deps.timeZone, deps.maxSendsPerDay)

  function onInitial(id: string, step: (q: Queries, at: Date, app: Application) => Result<InitialStep>, expect?: SendExpect): Result<Application> {
    return db.tx((q) => {
      const at = deps.now()
      const app = repo.getApplication(q, id)
      if (app === undefined) return fail('not-found', 'no such application')
      const seen = fresh(app, 'initial', expect)
      if (!seen.ok) return seen
      const planned = step(q, at, app)
      if (!planned.ok) return planned
      const { event, log } = planned.value
      const moved = appTransition(app, event, at)
      if (!moved.ok) return moved
      const row = moved.value.sends.find((s) => s.kind === 'initial')
      if (row === undefined) return fail('conflict', 'there is no initial send')
      const saved = repo.saveApplication(q, moved.value, log(row), at)
      return saved.ok ? ok(moved.value) : saved
    })
  }

  function onFollowup(id: string, kind: SendKind, step: (q: Queries, at: Date, f: Followup) => Result<FollowupStep>, expect?: SendExpect): Result<Send> {
    return db.tx((q) => {
      const at = deps.now()
      const app = repo.getApplication(q, id)
      const f = app === undefined ? undefined : followupOf(q, app, kind)
      if (app === undefined || f === undefined) return fail('not-found', `no such ${app === undefined ? 'application' : 'follow-up'}`)
      const seen = fresh(app, kind, expect)
      if (!seen.ok) return seen
      const planned = step(q, at, f)
      if (!planned.ok) return planned
      const plan = planned.value
      const current = app.sends.find((s) => s.kind === kind) ?? null
      const row = sendTransition(current, plan.send(current, f), at)
      if (!row.ok) return row
      const moved = move(q, f, plan.followup(app), at)
      if (!moved.ok) return moved
      const saved = repo.saveFollowup(q, moved.value, plan.log(row.value), at, row.value)
      return saved.ok ? ok(row.value) : saved
    })
  }

  const initialRow = (moved: Result<Application>): Result<Send> => (moved.ok ? rowOf(moved.value, 'initial') : moved)
  const context = (q: Queries, app: Application) => ({ state: app.state, hasHumanReply: hasHumanReply(q, app.id) })

  /**
   * «Approve»'s address guard (T-A11/T-F6, X4) for «Send again» and «Retry» (D9 step 2, revisión de E):
   * the recipient is the contact's own email, `verified` or with an override; «Send anyway» writes the
   * override (T-D5). Run only in the state the table moves from, so any other state stays its conflict.
   * The value: whether the row carries an override.
   */
  function guarded(q: Queries, at: Date, applies: boolean, to: { readonly contactId: string | null; readonly to: string | null }, sendAnyway: boolean): Result<boolean> {
    if (!applies) return ok(false)
    const gate = addressGuard(q, to.contactId, to.to, at, sendAnyway)
    if (!gate.ok) return gate
    const address = to.contactId === null ? null : (repo.getContact(q, to.contactId)?.address ?? null)
    const override = writeOverride(q, to.contactId, address, sendAnyway, at)
    return override.ok ? ok(gate.value.override !== 'none') : override
  }

  function resolveInitial(id: string, answer: UnknownAnswer, sendAnyway: boolean, expect: SendExpect | undefined): Result<Send> {
    const kind = 'initial'
    const step = (q: Queries, at: Date, app: Application): Result<InitialStep> => {
      if (answer === 'went') return ok({ event: { type: 'it-went' }, log: (row) => ({ kind: 'sent', data: { kind, messageId: row.messageId, answer } }) }) // T-A17 + T-S5
      if (answer === 'not-went') return ok({ event: { type: 'it-didnt-go' }, log: () => ({ kind: 'send-failed', data: { kind, reason: 'owner-not-sent' } }) }) // T-A31 + T-S10
      const again = app.state === 'send-unknown'
      const version = again ? sameVersion(app, kind, app.version) : ok(undefined)
      if (!version.ok) return version
      const guard = guarded(q, at, again, app.target, sendAnyway)
      if (!guard.ok) return guard
      return ok({ event: { type: 'send-again', cap: capOf(q, at) }, log: () => ({ kind: 'approved', data: { kind, again: true } }) }) // T-A18 + T-S6
    }
    return initialRow(onInitial(id, step, expect))
  }

  function resolveFollowup(id: string, kind: SendKind, answer: UnknownAnswer, sendAnyway: boolean, expect: SendExpect | undefined): Result<Send> {
    return onFollowup(id, kind, (q, at, f) => {
      if (answer === 'went') return ok({ followup: () => ({ type: 'it-went' }), send: () => ({ type: 'it-went' }), log: (row) => ({ kind: 'sent', data: { kind, messageId: row.messageId, answer } }) }) // T-F9 + T-S5
      if (answer === 'not-went') {
        return ok({
          followup: (app) => ({ type: 'it-didnt-go', app: context(q, app) }),
          send: () => ({ type: 'it-didnt-go', appState: repo.getApplication(q, id)?.state ?? 'sent' }),
          log: () => ({ kind: 'followup-cancelled', data: { kind, why: 'not-sent' } }),
        }) // T-F13 + T-S10
      }
      const again = f.state === 'send-unknown'
      const version = again ? sameFollowupVersion(q, f, kind) : ok(undefined)
      if (!version.ok) return version
      const guard = guarded(q, at, again, f, sendAnyway)
      if (!guard.ok) return guard
      const cap = capOf(q, at)
      return ok({ followup: (app) => ({ type: 'send-again', app: context(q, app), cap }), send: () => ({ type: 'send-again', cap }), log: () => ({ kind: 'approved', data: { kind, again: true } }) }) // T-F9 + T-S6
    }, expect)
  }

  function retryFollowup(id: string, kind: SendKind, sendAnyway: boolean, expect: SendExpect | undefined): Result<Send> {
    return onFollowup(id, kind, (q, at, f) => {
      const retry = f.state === 'failed'
      const version = retry ? sameFollowupVersion(q, f, kind) : ok(undefined)
      if (!version.ok) return version
      const guard = guarded(q, at, retry, f, sendAnyway)
      if (!guard.ok) return guard
      const cap = capOf(q, at)
      const profileVersion = repo.latestProfileVersion(q)?.version ?? null
      return ok({
        followup: () => ({ type: 'retry', cap }),
        send: () => ({ type: 'retry', messageId: newMessageId(at), cap, addressOverride: guard.value, profileVersion, artifactsVersion: f.version }),
        log: () => ({ kind: 'approved', data: { kind, retry: true } }),
      }) // T-F10 + T-S8
    }, expect)
  }

  /** Steps 2–3 after an action that left the row `sending`. */
  const launched = (id: string, kind: SendKind, row: Result<Send>): Result<Send> => {
    if (row.ok && row.value.state === 'sending') deps.sender.launch(id, kind)
    return row
  }

  return {
    resolveUnknown: (id, kind, answer, options = {}) => {
      const sendAnyway = options.addressOverride === true
      const row = kind === 'initial' ? resolveInitial(id, answer, sendAnyway, options.expect) : resolveFollowup(id, kind, answer, sendAnyway, options.expect)
      return launched(id, kind, enqueueIfPending(db, deps.enqueueCheck, id, kind, row))
    },

    retrySend: (id, kind, options = {}) => {
      if (kind !== 'initial') return launched(id, kind, enqueueIfPending(db, deps.enqueueCheck, id, kind, retryFollowup(id, kind, options.addressOverride === true, options.expect)))
      const app = db.read((q) => repo.getApplication(q, id))
      if (app === undefined) return fail('not-found', 'no such application')
      // Read and approved with no await between: nothing moves the row in the gap.
      const seen = fresh(app, 'initial', options.expect)
      if (!seen.ok) return seen
      const failed = rowOf(app, 'initial')
      if (!failed.ok || failed.value.state !== 'failed') return fail('conflict', 'only a failed send is retried')
      const version = pinnedVersion(failed.value, app.version)
      if (!version.ok) return version
      const approved = deps.sender.approve(id, 'initial', options) // T-A11 + T-S8, every check of step 1; it launches 2–3
      if (!approved.ok) return approved
      const after = db.read((q) => repo.getApplication(q, id))
      return after === undefined ? fail('not-found', 'no such application') : rowOf(after, 'initial')
    },

    markSent: (id, kind) => {
      if (kind === 'initial') return onInitial(id, () => ok({ event: { type: 'mark-sent' }, log: () => ({ kind: 'sent', data: { kind, manual: true } }) })) // T-A13 + T-S9
      const marked = onFollowup(id, kind, () =>
        ok<FollowupStep>({
          followup: () => ({ type: 'mark-sent' }),
          send: (_row, f) => ({ type: 'mark-sent', kind, followupId: f.id }),
          log: () => ({ kind: 'sent', data: { kind, manual: true } }),
        }),
      ) // T-F7 + T-S9
      if (!marked.ok) return marked
      const app = db.read((q) => repo.getApplication(q, id))
      return app === undefined ? fail('not-found', 'no such application') : ok(app)
    },
  }
}
