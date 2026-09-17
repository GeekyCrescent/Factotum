/**
 * The asks that are waiting for the owner. Kept apart from `engine.ts`, which already carries
 * launch, reply, cancel and the gate.
 *
 * IN MEMORY AND NOWHERE ELSE, and that is a security property, not a simplification. An ask's id
 * is what authorises its answer (spec §5), and the gated agent can READ ANY FILE on this machine
 * (`decide.ts`: reading is always allowed). An id written to the session log, to meta.json or to
 * any state file would be an id handed to the agent. It lives here and in the encrypted push.
 *
 * `list()` exists for tests and for `closeAll`, and returns no ids. No route exposes it.
 *
 * The clock and the timers are injected: the kernel owns the timers a module uses (CLAUDE.md §6),
 * and a test of an hour-long window cannot wait an hour.
 */

import { randomBytes } from 'node:crypto'
import type { Timers } from '@factotum/core'

export type AskOutcome =
  | { readonly kind: 'answered'; readonly decision: 'allow' | 'deny' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'shutdown'; readonly reason: string }

/** Discriminated by `kind`: a boolean cannot tell four outcomes apart. */
export type AnswerResult =
  | { readonly kind: 'answered' }
  /** Answered before. IDEMPOTENT, not an error: a service worker may retry (criterion 20). */
  | { readonly kind: 'already' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'unknown' }

export interface PendingAsk {
  readonly sessionId: string
  readonly toolName: string
  readonly target: string
  readonly deadlineAt: string
}

export interface AskRequest {
  readonly sessionId: string
  readonly toolName: string
  readonly target: string
}

export interface AskTable {
  /** The id goes into the notice; the promise is what the held hook reply waits on. */
  readonly open: (ask: AskRequest) => { readonly id: string; readonly outcome: Promise<AskOutcome> }
  readonly answer: (id: string, decision: 'allow' | 'deny') => AnswerResult
  readonly list: () => readonly PendingAsk[]
  readonly closeAll: (reason: string) => void
}

export interface AskTableDeps {
  readonly now: () => Date
  readonly timers: Timers
  readonly timeoutMs: number
}

interface Live {
  readonly ask: PendingAsk
  readonly resolve: (outcome: AskOutcome) => void
  readonly timer: Disposable
}

type Settled = 'answered' | 'expired'

/** 32 random bytes: not guessable, and not ordered by time the way a UUIDv7 is. */
function token(): string {
  return randomBytes(32).toString('base64url')
}

export function createAskTable(deps: AskTableDeps): AskTable {
  const live = new Map<string, Live>()
  // What happened to asks that are no longer live, so a late answer can be told "expired" or
  // "already" instead of "unknown". Pruned: an entry older than two windows answers nothing useful.
  const settled = new Map<string, { readonly how: Settled; readonly at: number }>()

  const settle = (id: string, how: Settled, outcome: AskOutcome): void => {
    const entry = live.get(id)
    if (entry === undefined) return
    live.delete(id)
    entry.timer[Symbol.dispose]()
    settled.set(id, { how, at: deps.now().getTime() })
    entry.resolve(outcome)
  }

  const prune = (): void => {
    const cutoff = deps.now().getTime() - 2 * deps.timeoutMs
    for (const [id, { at }] of settled) if (at < cutoff) settled.delete(id)
  }

  return {
    open: (request) => {
      prune()
      const id = token()
      const deadlineAt = new Date(deps.now().getTime() + deps.timeoutMs).toISOString()
      let resolve: (outcome: AskOutcome) => void = () => undefined
      const outcome = new Promise<AskOutcome>((r) => (resolve = r))
      const timer = deps.timers.setTimeout(() => settle(id, 'expired', { kind: 'expired' }), deps.timeoutMs)
      live.set(id, { ask: { ...request, deadlineAt }, resolve, timer })
      return { id, outcome }
    },

    answer: (id, decision) => {
      if (live.has(id)) {
        settle(id, 'answered', { kind: 'answered', decision })
        return { kind: 'answered' }
      }
      const past = settled.get(id)
      if (past === undefined) return { kind: 'unknown' }
      return past.how === 'answered' ? { kind: 'already' } : { kind: 'expired' }
    },

    list: () => [...live.values()].map((entry) => entry.ask),

    closeAll: (reason) => {
      for (const id of [...live.keys()]) settle(id, 'expired', { kind: 'shutdown', reason })
    },
  }
}
