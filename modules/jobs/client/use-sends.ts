/**
 * The send line of the batch bar (design D9 paso 4, D15; requirements crit. 38b).
 *
 * APPROVE DOES NOT WAIT FOR SMTP: `POST /batch/decide` answers once the send is `sending`, the screen
 * moves on, and each send it started is polled here — `GET /a/:id/sends/:kind` every `SEND_POLL_MS` —
 * until it is `sent`, `failed` or `send-unknown`. What each answer does to the lines is
 * `sends-model.ts`'s.
 *
 * THE OWNER'S ANSWERS — «Retry», «It went», «Send again», «It didn't go» — go through the screen's one
 * lock (`guard.ts`), the same that holds a decision: never two at once, and a double tap posts once.
 * Each acts on THAT send (`kind`), and the engine accepts it only from the state it was asked in
 * (`failed` for Retry, `send-unknown` for the rest), so an answer to a line already moved on is refused,
 * shown, and changes nothing.
 *
 * ONE LOOP: it runs while some line polls, and reads the lines from a ref, so an answer never restarts
 * it and never drops the reads still in flight. One request per send at a time: a slow read is not
 * stacked on. An answer that changes nothing draws nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { Api, SendState, SendView, UnknownRequest } from './contract.ts'
import type { Lock } from './guard.ts'
import { refusalOf, type SendKey } from './model.ts'
import { answerRefused, dismissed, isPolling, pollFailed, polled, repolled, retryRefused, sendIdOf, tracked, type SendAction, type TrackedSend } from './sends-model.ts'

export const SEND_POLL_MS = 1_000

export type { TrackedSend } from './sends-model.ts'

const pathOf = (key: SendKey): string => `a/${encodeURIComponent(key.applicationId)}/sends/${key.kind}`

export interface SendsState {
  readonly sends: readonly TrackedSend[]
  /** Starts following a send just approved (or retried). */
  readonly track: (key: SendKey, state?: SendState | null) => void
  /** «Retry» (`POST …/retry`, then followed again) or an answer to «did it go?» (`POST …/unknown`). */
  readonly act: (key: SendKey, action: SendAction) => Promise<void>
  /** «Retry polling» of a line that gave up reading. */
  readonly repoll: (key: SendKey) => void
  /** «Dismiss» a failed or unknown line. */
  readonly dismiss: (key: SendKey) => void
}

export function useSends(api: Api, lock: Lock): SendsState {
  const [sends, setSends] = useState<readonly TrackedSend[]>([])
  const latest = useRef(sends)
  latest.current = sends
  /** The sends with a read in flight, by `sendIdOf`: one at a time each. */
  const inFlight = useRef(new Set<string>())

  const track = useCallback((key: SendKey, state: SendState | null = null): void => setSends((now) => tracked(now, key, state)), [])

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

  const act = useCallback(
    async (key: SendKey, action: SendAction): Promise<void> => {
      await lock.run(async () => {
        try {
          if (action === 'retry') {
            await api.post(`${pathOf(key)}/retry`)
            track(key)
            return
          }
          const body: UnknownRequest = { answer: action }
          const view = await api.post<SendView>(`${pathOf(key)}/unknown`, body)
          setSends((now) => polled(now, key, view))
        } catch (cause) {
          const reason = refusalOf(cause).text
          setSends((now) => (action === 'retry' ? retryRefused(now, key, reason) : answerRefused(now, key, reason)))
        }
      })
    },
    [api, lock, track],
  )

  const repoll = useCallback((key: SendKey): void => setSends((now) => repolled(now, key)), [])
  const dismiss = useCallback((key: SendKey): void => setSends((now) => dismissed(now, key)), [])

  return { sends, track, act, repoll, dismiss }
}
