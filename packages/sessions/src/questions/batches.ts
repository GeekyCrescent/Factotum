/**
 * The batches of questions waiting for the owner (spec 2026-10-01-preguntas-con-opciones, D2).
 *
 * The pattern of `permissions/asks.ts`, whole, and for the same reason it is IN MEMORY AND NOWHERE ELSE:
 * a batch's token is what authorises its answer, and the agent can READ ANY FILE on this machine. A token
 * written to the log, the meta or any state file is a token handed to the agent. It lives here and in the
 * encrypted push.
 *
 * TWO IDS, AND THEY ARE NOT INTERCHANGEABLE. `token` authorises and never leaves this table except in the
 * push. `id` is public: it goes to the log to pair `asked` with `settled`, and to the URL so the client can
 * tell which pending a token belongs to. Knowing the id lets nobody answer anything.
 *
 * What this table adds to the ask table:
 *
 * - `closeSession`, because Cancel must release a waiting batch AT ONCE (criterion 21). Today an ask
 *   outlives its session's Cancel until its deadline; a batch must not.
 * - closing RETURNS what it closed, so whoever closes writes the `settled` — before the terminal state
 *   (design D5). Leaving it to the waiter put it after.
 * - how a batch ended is remembered and served by `get`, because "expired" and "cancelled" are different
 *   things to tell somebody who arrives late.
 */

import { randomBytes } from 'node:crypto'
import type { Timers } from '@factotum/core'
import type { Answer, Question } from './shape.ts'

export type BatchOutcome =
  | { readonly kind: 'answered'; readonly answers: readonly Answer[] }
  | { readonly kind: 'expired' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'shutdown'; readonly reason: string }

/** How a batch ended, for whoever arrives late. A shutdown reads as `cancelled`: to them it is the same. */
export type SettledHow = 'answered' | 'expired' | 'cancelled'

export type BatchAnswerResult =
  | { readonly kind: 'answered' }
  /** Answered before. IDEMPOTENT, not an error: a second device, or a retry. */
  | { readonly kind: 'already' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unknown' }

export interface PendingBatch {
  /** PUBLIC. Pairs `asked` with `settled` in the log. Authorises nothing. */
  readonly id: string
  readonly sessionId: string
  readonly siteId: string
  readonly questions: readonly Question[]
  /** The subagent that asked, or `undefined` for the main agent. */
  readonly task: string | undefined
  readonly deadlineAt: string
}

export type BatchRequest = Omit<PendingBatch, 'id' | 'deadlineAt'>

export interface BatchTable {
  readonly open: (request: BatchRequest) => {
    readonly token: string
    readonly id: string
    readonly outcome: Promise<BatchOutcome>
    readonly deadlineAt: string
  }
  /** The live batch, or HOW it ended. By token: whoever holds it could already answer it. Never a list. */
  readonly get: (token: string) => PendingBatch | { readonly over: SettledHow } | undefined
  /** The answers are already judged against the batch (`parseAnswers`); this only checks it is alive. */
  readonly answer: (token: string, answers: readonly Answer[]) => BatchAnswerResult
  /** → `cancelled`, SYNCHRONOUSLY. Returns what it closed so the caller writes the `settled`. */
  readonly closeSession: (sessionId: string) => readonly PendingBatch[]
  /** → `shutdown`. Same contract. */
  readonly closeAll: (reason: string) => readonly PendingBatch[]
  /** For tests and nothing else. No tokens. */
  readonly list: () => readonly PendingBatch[]
}

export interface BatchTableDeps {
  readonly now: () => Date
  readonly timers: Timers
  readonly timeoutMs: number
}

interface Live {
  readonly batch: PendingBatch
  readonly resolve: (outcome: BatchOutcome) => void
  readonly timer: Disposable
}

/** 32 random bytes: not guessable, and the shape `ask-token.ts` already recognises. */
function token(): string {
  return randomBytes(32).toString('base64url')
}

function publicId(): string {
  return randomBytes(16).toString('hex')
}

export function createBatchTable(deps: BatchTableDeps): BatchTable {
  const live = new Map<string, Live>()
  // How batches that are no longer live ended. Pruned: older than two windows answers nothing useful.
  const settled = new Map<string, { readonly how: SettledHow; readonly at: number }>()

  const settle = (key: string, how: SettledHow, outcome: BatchOutcome): PendingBatch | undefined => {
    const entry = live.get(key)
    if (entry === undefined) return undefined
    live.delete(key)
    entry.timer[Symbol.dispose]()
    settled.set(key, { how, at: deps.now().getTime() })
    entry.resolve(outcome)
    return entry.batch
  }

  const prune = (): void => {
    const cutoff = deps.now().getTime() - 2 * deps.timeoutMs
    for (const [key, { at }] of settled) if (at < cutoff) settled.delete(key)
  }

  const closeWhere = (match: (batch: PendingBatch) => boolean, outcome: BatchOutcome): readonly PendingBatch[] => {
    const closed: PendingBatch[] = []
    for (const [key, entry] of [...live]) {
      if (!match(entry.batch)) continue
      const batch = settle(key, 'cancelled', outcome)
      if (batch !== undefined) closed.push(batch)
    }
    return closed
  }

  return {
    open: (request) => {
      prune()
      const key = token()
      const id = publicId()
      const deadlineAt = new Date(deps.now().getTime() + deps.timeoutMs).toISOString()
      let resolve: (outcome: BatchOutcome) => void = () => undefined
      const outcome = new Promise<BatchOutcome>((r) => (resolve = r))
      const timer = deps.timers.setTimeout(() => settle(key, 'expired', { kind: 'expired' }), deps.timeoutMs)
      live.set(key, { batch: { ...request, id, deadlineAt }, resolve, timer })
      return { token: key, id, outcome, deadlineAt }
    },

    get: (key) => {
      const entry = live.get(key)
      if (entry !== undefined) return entry.batch
      const past = settled.get(key)
      return past === undefined ? undefined : { over: past.how }
    },

    answer: (key, answers) => {
      if (live.has(key)) {
        settle(key, 'answered', { kind: 'answered', answers })
        return { kind: 'answered' }
      }
      const past = settled.get(key)
      if (past === undefined) return { kind: 'unknown' }
      if (past.how === 'answered') return { kind: 'already' }
      return { kind: past.how }
    },

    closeSession: (sessionId) => closeWhere((batch) => batch.sessionId === sessionId, { kind: 'cancelled' }),

    closeAll: (reason) => closeWhere(() => true, { kind: 'shutdown', reason }),

    list: () => [...live.values()].map((entry) => entry.batch),
  }
}
