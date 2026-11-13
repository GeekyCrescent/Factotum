/**
 * The assistance panel's actions (design D9, task E3): «It went», «Send again», «It didn't go»,
 * «Retry» and «Mark as sent». Each takes the `kind` and acts on THAT row of `sends`.
 *
 * «Send again» and «Retry» go back to step 1 (with the cap) and on to 2–3 through the sender:
 * «Send again» keeps the `messageId` (T-S6: that one may have gone out); «Retry» of a `failed` row
 * UPDATEs the same row with a new one, the old to `attempts` (T-S8). For the initial, «Retry» IS the
 * approval (T-A11 + T-S8, with every check of step 1: v6 M1).
 *
 * A FOLLOW-UP ROW moves through `moveFollowup` (T-F7, T-F9, T-F10, T-F13), the step F2b connects like
 * B6's `afterSave`; by default it is the bare `followupTransition`.
 */

import { appTransition, followupTransition, sendTransition, type AppEvent, type FollowupEvent, type SendEvent } from '../state.ts'
import type { Db, Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { fail, ok, type Application, type Followup, type Result, type Send, type SendKind } from '../types.ts'
import { hasHumanReply } from './deferred.ts'
import { dailyCap, followupOf, newMessageId, type Sender } from './send.ts'

export type UnknownAnswer = 'went' | 'again' | 'not-went'

/** Moves a follow-up with the event of its row; F2b connects its own. */
export type MoveFollowup = (q: Queries, followup: Followup, event: FollowupEvent, now: Date) => Result<Followup>

export interface AssistDeps {
  readonly db: Db
  readonly now: () => Date
  readonly timeZone: string
  readonly maxSendsPerDay: number
  readonly sender: Pick<Sender, 'approve' | 'launch'>
  readonly moveFollowup?: MoveFollowup
}

export interface Assist {
  readonly resolveUnknown: (id: string, kind: SendKind, answer: UnknownAnswer) => Result<Send>
  readonly retrySend: (id: string, kind: SendKind) => Result<Send>
  readonly markSent: (id: string, kind: SendKind) => Result<Application>
}

const rowOf = (app: Application, kind: SendKind): Result<Send> => {
  const row = app.sends.find((s) => s.kind === kind)
  return row === undefined ? fail('conflict', `there is no ${kind} send`) : ok(row)
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

  function onInitial(id: string, step: (q: Queries, at: Date) => InitialStep): Result<Application> {
    return db.tx((q) => {
      const at = deps.now()
      const app = repo.getApplication(q, id)
      if (app === undefined) return fail('not-found', 'no such application')
      const { event, log } = step(q, at)
      const moved = appTransition(app, event, at)
      if (!moved.ok) return moved
      const row = moved.value.sends.find((s) => s.kind === 'initial')
      if (row === undefined) return fail('conflict', 'there is no initial send')
      const saved = repo.saveApplication(q, moved.value, log(row), at)
      return saved.ok ? ok(moved.value) : saved
    })
  }

  function onFollowup(id: string, kind: SendKind, step: (q: Queries, at: Date) => FollowupStep): Result<Send> {
    return db.tx((q) => {
      const at = deps.now()
      const app = repo.getApplication(q, id)
      const f = app === undefined ? undefined : followupOf(q, app, kind)
      if (app === undefined || f === undefined) return fail('not-found', `no such ${app === undefined ? 'application' : 'follow-up'}`)
      const plan = step(q, at)
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

  function resolveInitial(id: string, answer: UnknownAnswer): Result<Send> {
    const kind = 'initial'
    const step = (q: Queries, at: Date): InitialStep => {
      if (answer === 'went') return { event: { type: 'it-went' }, log: (row) => ({ kind: 'sent', data: { kind, messageId: row.messageId, answer } }) } // T-A17 + T-S5
      if (answer === 'again') return { event: { type: 'send-again', cap: capOf(q, at) }, log: () => ({ kind: 'approved', data: { kind, again: true } }) } // T-A18 + T-S6
      return { event: { type: 'it-didnt-go' }, log: () => ({ kind: 'send-failed', data: { kind, reason: 'owner-not-sent' } }) } // T-A31 + T-S10
    }
    return initialRow(onInitial(id, step))
  }

  function resolveFollowup(id: string, kind: SendKind, answer: UnknownAnswer): Result<Send> {
    return onFollowup(id, kind, (q, at) => {
      if (answer === 'went') return { followup: () => ({ type: 'it-went' }), send: () => ({ type: 'it-went' }), log: (row) => ({ kind: 'sent', data: { kind, messageId: row.messageId, answer } }) } // T-F9 + T-S5
      if (answer === 'again') {
        const cap = capOf(q, at)
        return { followup: (app) => ({ type: 'send-again', app: context(q, app), cap }), send: () => ({ type: 'send-again', cap }), log: () => ({ kind: 'approved', data: { kind, again: true } }) } // T-F9 + T-S6
      }
      return {
        followup: (app) => ({ type: 'it-didnt-go', app: context(q, app) }),
        send: () => ({ type: 'it-didnt-go', appState: repo.getApplication(q, id)?.state ?? 'sent' }),
        log: () => ({ kind: 'followup-cancelled', data: { kind, why: 'not-sent' } }),
      } // T-F13 + T-S10
    })
  }

  function retryFollowup(id: string, kind: SendKind): Result<Send> {
    return onFollowup(id, kind, (q, at) => {
      const cap = capOf(q, at)
      const profileVersion = repo.latestProfileVersion(q)?.version ?? null
      return {
        followup: () => ({ type: 'retry', cap }),
        send: (row) => ({ type: 'retry', messageId: newMessageId(at), cap, addressOverride: row?.addressOverride ?? false, profileVersion }),
        log: () => ({ kind: 'approved', data: { kind, retry: true } }),
      } // T-F10 + T-S8
    })
  }

  /** Steps 2–3 after an action that left the row `sending`. */
  const launched = (id: string, kind: SendKind, row: Result<Send>): Result<Send> => {
    if (row.ok && row.value.state === 'sending') deps.sender.launch(id, kind)
    return row
  }

  return {
    resolveUnknown: (id, kind, answer) => launched(id, kind, kind === 'initial' ? resolveInitial(id, answer) : resolveFollowup(id, kind, answer)),

    retrySend: (id, kind) => {
      if (kind !== 'initial') return launched(id, kind, retryFollowup(id, kind))
      const app = db.read((q) => repo.getApplication(q, id))
      if (app === undefined) return fail('not-found', 'no such application')
      const failed = rowOf(app, 'initial')
      if (!failed.ok || failed.value.state !== 'failed') return fail('conflict', 'only a failed send is retried')
      const approved = deps.sender.approve(id, 'initial') // T-A11 + T-S8, every check of step 1; it launches 2–3
      if (!approved.ok) return approved
      const after = db.read((q) => repo.getApplication(q, id))
      return after === undefined ? fail('not-found', 'no such application') : rowOf(after, 'initial')
    },

    markSent: (id, kind) => {
      if (kind === 'initial') return onInitial(id, () => ({ event: { type: 'mark-sent' }, log: () => ({ kind: 'sent', data: { kind, manual: true } }) })) // T-A13 + T-S9
      const marked = onFollowup(id, kind, () => ({
        followup: () => ({ type: 'mark-sent' }),
        send: (_row, f) => ({ type: 'mark-sent', kind, followupId: f.id }),
        log: () => ({ kind: 'sent', data: { kind, manual: true } }),
      })) // T-F7 + T-S9
      if (!marked.ok) return marked
      const app = db.read((q) => repo.getApplication(q, id))
      return app === undefined ? fail('not-found', 'no such application') : ok(app)
    },
  }
}
