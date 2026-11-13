/**
 * What was seen is what is approved (spec 2026-11-12-postulaciones, design D15 «Lo que se vio es lo
 * que se aprueba»). Pure, no DOM: the screen asks these before it posts a decision.
 *
 * THE SETTLE: a card just put on screen — a new item, or the same item changed under the finger —
 * takes no Approve and no Skip for `SETTLE_MS`, so a double tap or a held key that outlives one round
 * trip never decides the NEXT card without it being seen.
 */

import type { BatchView, Decision, ItemResult, ReviewItem } from './contract.ts'

/** How long a card just shown refuses Approve and Skip. */
export const SETTLE_MS = 700

/** The card shown at `shownAt` (ms) takes a decision at `now` (ms). A clock gone backwards does not unlock it. */
export function canDecide(shownAt: number, now: number): boolean {
  return now - shownAt >= SETTLE_MS
}

/** How long, in ms, until the card shown at `shownAt` takes a decision; 0 when it already does. */
export function settleLeft(shownAt: number, now: number): number {
  const elapsed = now - shownAt
  if (elapsed < 0) return SETTLE_MS
  return Math.max(0, SETTLE_MS - elapsed)
}

/**
 * What the card on screen shows, for the settle: another item, or the same item whose `seen` changed
 * (a rewrite came back, the address or a warning moved), is a new card. `''` when there is none.
 */
export function viewOf(item: ReviewItem | undefined): string {
  return item === undefined ? '' : `${item.itemId}\u0000${item.seen}`
}

/** The decision as posted: on the item on screen, with the `seen` of the card the owner looked at. */
export function decisionOn(item: ReviewItem, decision: Omit<Decision, 'itemId' | 'seen'>): Decision {
  return { ...decision, itemId: item.itemId, seen: item.seen }
}

/**
 * DECIDED HERE, NOT YET READ BACK: a decision that went through is kept by `itemId` until a read of the
 * batch shows its result (or the item is gone). Until then the screen treats the item as decided, so a
 * failed or stale read after the decision never brings back what was just approved.
 */
export type LocalResults = ReadonlyMap<string, ItemResult>

const LOCAL: Readonly<Partial<Record<Decision['kind'], ItemResult>>> = { approve: 'approved', skip: 'skipped', instruct: 'instructed' }

/** The result a decision that went through gives its item; null for one that decides nothing (override, switch). */
export function localResultOf(kind: Decision['kind']): ItemResult | null {
  return LOCAL[kind] ?? null
}

/** The batch as the screen uses it: the daemon's results, and the local ones where it has none yet. */
export function withLocal(batch: BatchView, local: LocalResults): BatchView {
  const missing = [...local].filter(([itemId]) => batch.results[itemId] === undefined)
  if (missing.length === 0) return batch
  return { ...batch, results: { ...Object.fromEntries(missing), ...batch.results } }
}

/** The local results a read has not confirmed yet; the same map when nothing changed. */
export function confirmedLocal(local: LocalResults, batch: BatchView): LocalResults {
  const present = new Set(batch.items.map((item) => item.itemId))
  const kept = [...local].filter(([itemId]) => present.has(itemId) && batch.results[itemId] === undefined)
  return kept.length === local.size ? local : new Map(kept)
}

/**
 * ONE DECISION IN FLIGHT: a synchronous lock, not React state — two clicks in one frame both read the
 * same `busy`, but the second `run` finds the lock taken. Released in `finally`, whatever happened.
 */
export interface Lock {
  /** Runs `task` and holds the lock until it settles; `null`, without running it, when held. */
  readonly run: <T>(task: () => Promise<T>) => Promise<T> | null
  readonly held: () => boolean
}

export function createLock(): Lock {
  let taken = false
  const run = <T>(task: () => Promise<T>): Promise<T> | null => {
    if (taken) return null
    taken = true
    const settle = async (): Promise<T> => {
      try {
        return await task()
      } finally {
        taken = false
      }
    }
    return settle()
  }
  return { run, held: () => taken }
}

/** What the screen says when the lock refuses an action: never dropped in silence. */
export const LOCK_HELD = 'Another action is still running — try again in a moment.'

/** `lock.run`, and when the lock is held, `say(LOCK_HELD)` before answering null. */
export function runOrSay<T>(lock: Lock, task: () => Promise<T>, say: (text: string) => void): Promise<T> | null {
  const running = lock.run(task)
  if (running === null) say(LOCK_HELD)
  return running
}
