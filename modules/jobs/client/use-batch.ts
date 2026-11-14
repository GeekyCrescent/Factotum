/**
 * The open batch as the daemon has it, and every decision sent to it (design D15; crit. 28, 35).
 *
 * NO OPTIMISM, as the task board: a decision is posted and the batch read again. The batch is kept
 * by the daemon, so closing the app and coming back carries on where it was (crit. 28).
 *
 * THE NEWEST READ WINS: every read takes a number, and an answer older than the last one applied is
 * dropped — a slow poll must not paint over the read after a decision.
 *
 * THE POLL (`POLL_MS`, as tasks): `GET /batch` every 2 s while something in the batch rewrites or an
 * address waits for its check (`shouldPollBatch`), and only with the page visible.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { Api, BatchAnswer, DecideAnswer, Decision } from './contract.ts'
import { createLock } from './guard.ts'
import { msUntilStale, refusalOf, shouldPollBatch, type Refusal } from './model.ts'

export const POLL_MS = 2_000
/** The longest a `setTimeout` waits (2^31 - 1 ms); a longer wait is taken in steps. */
const MAX_TIMER_MS = 2_147_483_647

export interface BatchState {
  readonly answer: BatchAnswer | undefined
  readonly error: string | undefined
  readonly clearError: () => void
  readonly reload: () => Promise<void>
  /** `POST /batch`: arms a new batch. */
  readonly start: () => Promise<void>
  /** Posts, reads the batch again; resolves with the answer, or the refusal. Never rejects. */
  readonly decide: (decision: Decision) => Promise<DecideAnswer | Refusal>
}

export const isRefusal = (outcome: DecideAnswer | Refusal): outcome is Refusal => 'text' in outcome

export function useBatch(api: Api): BatchState {
  const [answer, setAnswer] = useState<BatchAnswer | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const reads = useRef({ started: 0, applied: 0 })

  const apply = useCallback((mine: number, next: BatchAnswer): void => {
    if (mine < reads.current.applied) return
    reads.current.applied = mine
    setAnswer(next)
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++reads.current.started
    try {
      apply(mine, await api.get<BatchAnswer>('batch'))
    } catch (cause) {
      if (mine >= reads.current.applied) setError(refusalOf(cause).text)
    }
  }, [api, apply])

  /** «Start review» twice in one frame arms ONE batch: the second press finds the lock taken. */
  const starting = useMemo(createLock, [])
  const start = useCallback(async (): Promise<void> => {
    await starting.run(async () => {
      const mine = ++reads.current.started
      try {
        apply(mine, await api.post<BatchAnswer>('batch'))
        setError(undefined)
      } catch (cause) {
        setError(refusalOf(cause).text)
      }
    })
  }, [api, apply, starting])

  const decide = useCallback(
    async (decision: Decision): Promise<DecideAnswer | Refusal> => {
      let outcome: DecideAnswer | Refusal
      try {
        outcome = await api.post<DecideAnswer>('batch/decide', decision)
        setError(undefined)
      } catch (cause) {
        outcome = refusalOf(cause)
      }
      await reload()
      return outcome
    },
    [api, reload],
  )

  useEffect(() => {
    void reload()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [reload])

  const batch = answer?.batch ?? null
  const polling = batch !== null && shouldPollBatch(batch, new Date())
  useEffect(() => {
    if (!polling) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [polling, reload])

  // Not polled, but an address goes stale by the clock alone: read again then, and the poll starts.
  const staleIn = batch === null || polling ? null : msUntilStale(batch, new Date())
  useEffect(() => {
    if (staleIn === null) return
    const timer = setTimeout(() => void reload(), Math.min(staleIn, MAX_TIMER_MS))
    return () => clearTimeout(timer)
  }, [staleIn, reload])

  const clearError = useCallback(() => setError(undefined), [])
  return { answer, error, clearError, reload, start, decide }
}
