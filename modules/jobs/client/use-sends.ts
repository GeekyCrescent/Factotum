/**
 * The send line of the batch bar (design D9 paso 4, D15; requirements crit. 38b).
 *
 * APPROVE DOES NOT WAIT FOR SMTP: `POST /batch/decide` answers once the send is `sending`, the screen
 * moves on, and each send it started is polled here — `GET /a/:id/sends/:kind` every `SEND_POLL_MS` —
 * until it is `sent`, `failed` or `send-unknown`. A failed read keeps the last line and tries again.
 */

import { useCallback, useEffect, useState } from 'preact/hooks'
import type { Api, SendView } from './contract.ts'
import { sendLine, type SendKey, type SendLine } from './model.ts'

export const SEND_POLL_MS = 1_000
/** The lines kept in the bar: the newest few. */
const MAX_LINES = 3

export interface TrackedSend {
  readonly key: SendKey
  readonly line: SendLine
}

const pathOf = (key: SendKey): string => `a/${encodeURIComponent(key.applicationId)}/sends/${key.kind}`
const same = (a: SendKey, b: SendKey): boolean => a.applicationId === b.applicationId && a.kind === b.kind

export interface SendsState {
  readonly sends: readonly TrackedSend[]
  /** Starts following a send just approved (or retried). */
  readonly track: (key: SendKey) => void
  /** `POST /a/:id/sends/:kind/retry`, then follows it again. */
  readonly retry: (key: SendKey) => Promise<void>
}

export function useSends(api: Api): SendsState {
  const [sends, setSends] = useState<readonly TrackedSend[]>([])

  const track = useCallback((key: SendKey): void => {
    const line = sendLine({ kind: key.kind, state: 'sending', at: '', reason: null }, key.company)
    setSends((now) => [...now.filter((send) => !same(send.key, key)), { key, line }].slice(-MAX_LINES))
  }, [])

  const pending = sends.some((send) => !send.line.final)
  useEffect(() => {
    if (!pending) return
    let live = true
    const timer = setInterval(() => {
      for (const send of sends) {
        if (send.line.final) continue
        api
          .get<SendView>(pathOf(send.key))
          .then((view) => {
            if (!live) return
            const line = sendLine(view, send.key.company)
            setSends((now) => now.map((one) => (same(one.key, send.key) ? { key: one.key, line } : one)))
          })
          .catch(() => {
            // A missed poll is not news: the line stays «Sending…» and the next tick asks again.
          })
      }
    }, SEND_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [api, pending, sends])

  const retry = useCallback(
    async (key: SendKey): Promise<void> => {
      try {
        await api.post(`${pathOf(key)}/retry`)
        track(key)
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : 'the retry failed'
        const line: SendLine = { text: `${key.company}: ${reason}`, tone: 'err', final: true, retry: true }
        setSends((now) => now.map((one) => (same(one.key, key) ? { key, line } : one)))
      }
    },
    [api, track],
  )

  return { sends, track, retry }
}
