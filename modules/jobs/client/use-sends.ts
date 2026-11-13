/**
 * The send line of the batch bar (design D9 paso 4, D15; requirements crit. 38b).
 *
 * APPROVE DOES NOT WAIT FOR SMTP: `POST /batch/decide` answers once the send is `sending`, the screen
 * moves on, and each send it started is polled here — `GET /a/:id/sends/:kind` every `SEND_POLL_MS` —
 * until it is `sent`, `failed` or `send-unknown`. What each answer does to the lines is
 * `sends-model.ts`'s.
 *
 * ONE LOOP: it runs while some line polls, and reads the lines from a ref, so an answer never restarts
 * it and never drops the reads still in flight. One request per send at a time: a slow read is not
 * stacked on. An answer that changes nothing draws nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { Api, SendView } from './contract.ts'
import type { SendKey } from './model.ts'
import { dismissed, isPolling, pollFailed, polled, repolled, retryRefused, sendIdOf, tracked, type TrackedSend } from './sends-model.ts'

export const SEND_POLL_MS = 1_000

export type { TrackedSend } from './sends-model.ts'

const pathOf = (key: SendKey): string => `a/${encodeURIComponent(key.applicationId)}/sends/${key.kind}`

export interface SendsState {
  readonly sends: readonly TrackedSend[]
  /** Starts following a send just approved (or retried). */
  readonly track: (key: SendKey) => void
  /** `POST /a/:id/sends/:kind/retry`, then follows it again. */
  readonly retry: (key: SendKey) => Promise<void>
  /** «Retry polling» of a line that gave up reading. */
  readonly repoll: (key: SendKey) => void
  /** «Dismiss» a failed or unknown line. */
  readonly dismiss: (key: SendKey) => void
}

export function useSends(api: Api): SendsState {
  const [sends, setSends] = useState<readonly TrackedSend[]>([])
  const latest = useRef(sends)
  latest.current = sends
  /** The sends with a read in flight, by `sendIdOf`: one at a time each. */
  const inFlight = useRef(new Set<string>())
  /** The sends whose «Retry» is being posted. */
  const retrying = useRef(new Set<string>())

  const track = useCallback((key: SendKey): void => setSends((now) => tracked(now, key)), [])

  const polling = sends.some(isPolling)
  useEffect(() => {
    if (!polling) return
    const stop = new AbortController()
    const read = (send: TrackedSend): void => {
      const id = sendIdOf(send.key)
      if (inFlight.current.has(id)) return
      inFlight.current.add(id)
      api
        .get<SendView>(pathOf(send.key))
        .then((view) => {
          if (!stop.signal.aborted) setSends((now) => polled(now, send.key, view))
        })
        .catch(() => {
          // Counted, not swallowed: after MAX_POLL_FAILURES in a row the line says «status unknown».
          if (!stop.signal.aborted) setSends((now) => pollFailed(now, send.key))
        })
        .finally(() => inFlight.current.delete(id))
    }
    const timer = setInterval(() => latest.current.filter(isPolling).forEach(read), SEND_POLL_MS)
    return () => {
      stop.abort()
      clearInterval(timer)
    }
  }, [api, polling])

  const retry = useCallback(
    async (key: SendKey): Promise<void> => {
      // A double tap on «Retry» resends once.
      const id = sendIdOf(key)
      if (retrying.current.has(id)) return
      retrying.current.add(id)
      try {
        await api.post(`${pathOf(key)}/retry`)
        track(key)
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : 'the retry failed'
        setSends((now) => retryRefused(now, key, reason))
      } finally {
        retrying.current.delete(id)
      }
    },
    [api, track],
  )

  const repoll = useCallback((key: SendKey): void => setSends((now) => repolled(now, key)), [])
  const dismiss = useCallback((key: SendKey): void => setSends((now) => dismissed(now, key)), [])

  return { sends, track, retry, repoll, dismiss }
}
