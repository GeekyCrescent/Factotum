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
 * shown, and changes nothing. ONLY a 4xx with the engine's error body is a refusal: an answer whose
 * response is lost (network, timeout, 5xx) may have started the send, so the line says «couldn't
 * confirm — checking…» and polls the send again (`answerUnconfirmed`), never offering «Retry» blind.
 *
 * WHAT THE CARD SHOWED TRAVELS WITH THE ANSWER: `{ expect: { state, at } }` of the row as last read. A
 * row that moved since — answered on another device, or the send finished — comes back `409 stale`,
 * and the line is read again and says «this send changed — check it again» (D15). Coming back to
 * the screen (focus, a tab made visible) reads again every line that waits for the owner.
 *
 * ONE LOOP: it runs while some line polls, and reads the lines from a ref, so an answer never restarts
 * it and never drops the reads still in flight. One request per send at a time: a slow read is not
 * stacked on. An answer that changes nothing draws nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { Api, RetryRequest, SendNeed, SendState, SendView, UnknownRequest } from './contract.ts'
import type { Lock } from './guard.ts'
import { refusalOf, type SendKey } from './model.ts'
import {
  answerRefused,
  answerUnconfirmed,
  dismissed,
  expectOf,
  isPolling,
  isSendRefusal,
  isStaleRefusal,
  pollFailed,
  polled,
  repolled,
  retryRefused,
  seeded,
  sendIdOf,
  staleRead,
  toRefresh,
  tracked,
  type SendAction,
  type TrackedSend,
} from './sends-model.ts'

export const SEND_POLL_MS = 1_000

export type { TrackedSend } from './sends-model.ts'

const pathOf = (key: SendKey): string => `a/${encodeURIComponent(key.applicationId)}/sends/${key.kind}`

export interface SendsState {
  readonly sends: readonly TrackedSend[]
  /** Starts following a send just approved (or retried). */
  readonly track: (key: SendKey, state?: SendState | null) => void
  /** «Retry» (`POST …/retry`, then followed again) or an answer to «did it go?» (`POST …/unknown`). */
  readonly act: (key: SendKey, action: SendAction) => Promise<void>
  /** The sends that need the owner, as the tracker read them (`GET /overview`). */
  readonly seed: (needs: readonly SendNeed[]) => void
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
  /** Unmounted: an answer that arrives later draws nothing. */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const track = useCallback((key: SendKey, state: SendState | null = null): void => setSends((now) => tracked(now, key, state)), [])

  const read = useCallback(
    (send: TrackedSend): void => {
      const id = sendIdOf(send.key)
      if (inFlight.current.has(id)) return
      inFlight.current.add(id)
      api
        .get<SendView>(pathOf(send.key))
        .then((view) => {
          if (alive.current) setSends((now) => polled(now, send.key, view))
        })
        .catch(() => {
          // Counted, not swallowed: after MAX_POLL_FAILURES in a row the line says «status unknown».
          if (alive.current) setSends((now) => pollFailed(now, send.key))
        })
        .finally(() => inFlight.current.delete(id))
    },
    [api],
  )

  const polling = sends.some(isPolling)
  useEffect(() => {
    if (!polling) return
    const timer = setInterval(() => latest.current.filter(isPolling).forEach(read), SEND_POLL_MS)
    return () => clearInterval(timer)
  }, [read, polling])

  // Back on the screen: what waits for the owner may have been answered elsewhere meanwhile.
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'visible') toRefresh(latest.current).forEach(read)
    }
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [read])

  /** After a `409 stale`: the row as it is now, saying it changed; a read that fails keeps checking. */
  const reread = useCallback(
    async (key: SendKey): Promise<void> => {
      try {
        const view = await api.get<SendView>(pathOf(key))
        if (alive.current) setSends((now) => staleRead(now, key, view))
      } catch {
        if (alive.current) setSends((now) => answerUnconfirmed(now, key))
      }
    },
    [api],
  )

  const act = useCallback(
    async (key: SendKey, action: SendAction): Promise<void> => {
      const send = latest.current.find((line) => sendIdOf(line.key) === sendIdOf(key))
      if (send === undefined) return
      const expect = expectOf(send)
      const seen: RetryRequest = expect === null ? {} : { expect }
      await lock.run(async () => {
        try {
          if (action === 'retry') {
            const view = await api.post<SendView>(`${pathOf(key)}/retry`, seen)
            setSends((now) => polled(tracked(now, key), key, view))
            return
          }
          const body: UnknownRequest = { answer: action, ...seen }
          const view = await api.post<SendView>(`${pathOf(key)}/unknown`, body)
          setSends((now) => polled(now, key, view))
        } catch (cause) {
          // A lost response is not a refusal: the send may be going out. Read it again, never «Retry».
          if (!isSendRefusal(cause)) {
            setSends((now) => answerUnconfirmed(now, key))
            return
          }
          // Moved since the card was drawn (another device): nothing was done; show it as it is now.
          if (isStaleRefusal(cause)) {
            await reread(key)
            return
          }
          const reason = refusalOf(cause).text
          setSends((now) => (action === 'retry' ? retryRefused(now, key, reason) : answerRefused(now, key, reason)))
        }
      })
    },
    [api, lock, reread],
  )

  const seed = useCallback((needs: readonly SendNeed[]): void => setSends((now) => seeded(now, needs)), [])
  const repoll = useCallback((key: SendKey): void => setSends((now) => repolled(now, key)), [])
  const dismiss = useCallback((key: SendKey): void => setSends((now) => dismissed(now, key)), [])

  return { sends, track, act, seed, repoll, dismiss }
}
