/**
 * Folder requests waiting for the owner: an ask with no session (spec 2026-09-29, D3; ADR-0011).
 *
 * THE TOKEN IS THE AUTHORISATION, exactly like an ask's (`asks.ts`), and it lives in the same two
 * places: here, in memory, and in the encrypted push. It never goes in a response — `open` hands it
 * to the engine for the notice, and the route answers with `requestId`, which only reads a status —
 * and it never touches the disk, where the agent could read it.
 *
 * THE FIRST ANSWER DECIDES, AND EVERY ANSWER GETS ITS RESULT. The first one disarms the deadline
 * and, for `allow`, runs `apply` — the write, which the engine queues behind any other — and keeps
 * its promise. A second answer arriving while that write is still going gets THE SAME PROMISE, so
 * two taps say the same thing (criterion 9). If `apply` throws, both say `rejected` with why.
 *
 * The clock and the timers are injected: the kernel owns every timer a module uses (CLAUDE.md §6).
 */

import { randomBytes, randomUUID } from 'node:crypto'
import type { Timers } from '@factotum/core'
import type { Color, GrantOutcome, GrantStatus } from '../types.ts'

/** How long a request waits for the owner (requirements, assumption 16). */
export const GRANT_TIMEOUT_MS = 10 * 60 * 1000

/** How many may wait at once (criterion 21): a local process cannot flood the owner's phone. */
export const MAX_PENDING_GRANTS = 3

export type GrantRequest =
  | {
      readonly kind: 'project'
      /** The RESOLVED path: what is registered, and what approving compares against. */
      readonly path: string
      readonly id: string
      readonly name: string | undefined
      readonly color: Color | undefined
      /** The resolved folder's name, for the notices. Never the path: notices leave the tailnet. */
      readonly base: string
    }
  | { readonly kind: 'shared'; readonly path: string; readonly base: string }

export type GrantAnswer = (GrantOutcome & { readonly first: boolean }) | { readonly outcome: 'unknown' | 'expired' }

export interface GrantTable {
  readonly open: (request: GrantRequest) => { readonly requestId: string; readonly token: string; readonly expiresAt: string }
  readonly answer: (token: string, decision: 'allow' | 'deny', apply: () => Promise<GrantOutcome>) => Promise<GrantAnswer>
  /** One request BY ITS TOKEN, for the approval panel. `settled` once answered or expired. */
  readonly get: (token: string) => (GrantRequest & { readonly expiresAt: string; readonly requestId: string }) | 'settled' | undefined
  readonly status: (requestId: string) => GrantStatus
  readonly pendingCount: () => number
  /** Whether a request for this resolved folder is already waiting: one request per folder. */
  readonly waitingFor: (path: string) => boolean
  readonly closeAll: (reason: string) => void
}

export interface GrantTableDeps {
  readonly now: () => Date
  readonly timers: Timers
  readonly timeoutMs?: number
}

interface Pending {
  readonly requestId: string
  readonly request: GrantRequest
  readonly expiresAt: string
  readonly timer: Disposable
}

interface Settlement {
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'rejected'
  reason: string | undefined
  readonly at: number
  /** The promise every answer to this request returns, once the first one arrived. */
  result: Promise<GrantOutcome> | undefined
  readonly token: string
}

function token(): string {
  return randomBytes(32).toString('base64url')
}

export function createGrantTable(deps: GrantTableDeps): GrantTable {
  const timeoutMs = deps.timeoutMs ?? GRANT_TIMEOUT_MS
  const pending = new Map<string, Pending>()
  const records = new Map<string, Settlement>()
  const byToken = new Map<string, string>()

  /** Settled records older than two windows answer nothing useful: dropped. */
  const prune = (): void => {
    const cutoff = deps.now().getTime() - 2 * timeoutMs
    for (const [requestId, record] of records) {
      if (record.status !== 'pending' && record.at < cutoff) {
        records.delete(requestId)
        byToken.delete(record.token)
      }
    }
  }

  const expire = (key: string, reason: string | undefined): void => {
    const entry = pending.get(key)
    if (entry === undefined) return
    pending.delete(key)
    entry.timer[Symbol.dispose]()
    const record = records.get(entry.requestId)
    if (record !== undefined) {
      record.status = 'expired'
      record.reason = reason
    }
  }

  return {
    open: (request) => {
      prune()
      const key = token()
      const requestId = randomUUID()
      const expiresAt = new Date(deps.now().getTime() + timeoutMs).toISOString()
      const timer = deps.timers.setTimeout(() => expire(key, 'nobody answered in time'), timeoutMs)
      pending.set(key, { requestId, request, expiresAt, timer })
      records.set(requestId, { status: 'pending', reason: undefined, at: deps.now().getTime(), result: undefined, token: key })
      byToken.set(key, requestId)
      return { requestId, token: key, expiresAt }
    },

    answer: async (key, decision, apply) => {
      const entry = pending.get(key)
      if (entry !== undefined) {
        // THE FIRST ANSWER: out of `pending` and its deadline disarmed BEFORE anything is awaited,
        // so a second answer in the same tick finds the promise below and not a live request.
        pending.delete(key)
        entry.timer[Symbol.dispose]()
        const record = records.get(entry.requestId)
        const result: Promise<GrantOutcome> =
          decision === 'deny'
            ? Promise.resolve({ outcome: 'denied', reason: undefined })
            : apply().catch((error: unknown): GrantOutcome => ({
                outcome: 'rejected',
                reason: error instanceof Error ? error.message : String(error),
              }))
        if (record !== undefined) record.result = result
        const outcome = await result
        if (record !== undefined) {
          record.status = outcome.outcome
          record.reason = outcome.reason
        }
        return { ...outcome, first: true }
      }
      const requestId = byToken.get(key)
      const record = requestId === undefined ? undefined : records.get(requestId)
      if (record === undefined) return { outcome: 'unknown' }
      if (record.result === undefined) return { outcome: 'expired' }
      return { ...(await record.result), first: false }
    },

    get: (key) => {
      const entry = pending.get(key)
      if (entry !== undefined) return { ...entry.request, expiresAt: entry.expiresAt, requestId: entry.requestId }
      return byToken.has(key) ? 'settled' : undefined
    },

    status: (requestId) => {
      const record = records.get(requestId)
      return record === undefined ? { status: 'unknown' } : { status: record.status, reason: record.reason }
    },

    pendingCount: () => pending.size,

    waitingFor: (path) => [...pending.values()].some((entry) => entry.request.path === path),

    closeAll: (reason) => {
      for (const key of [...pending.keys()]) expire(key, reason)
    },
  }
}
