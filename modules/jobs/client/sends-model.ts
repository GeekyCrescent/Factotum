/**
 * The send lines of the batch bar, as data (design D9 paso 4, D15; requirements crit. 38b). Pure:
 * `use-sends.ts` polls and draws, these say what each answer — or each failed read — does to the lines.
 *
 * WHAT STAYS: a line that needs the owner — failed (with «Retry») or unknown («did it go?», «status
 * unknown») — stays until dismissed. Only a final ok line («Sent ✓») is evicted, oldest first, once the
 * bar holds more than `MAX_LINES`.
 *
 * A FAILED READ IS NOT NEWS, many are: after `MAX_POLL_FAILURES` in a row the line says «status unknown
 * — check the tracker», stops polling and offers «Retry polling». Never «Retry» the send: whether it
 * went is exactly what is unknown.
 */

import type { SendView } from './contract.ts'
import { sendLine, type SendKey, type SendLine } from './model.ts'

/** The bar shows this many lines when it can drop ok ones. */
export const MAX_LINES = 3
/** Failed reads in a row before the line gives up and says so. */
export const MAX_POLL_FAILURES = 5

export interface TrackedSend {
  readonly key: SendKey
  readonly line: SendLine
  /** Failed reads in a row. */
  readonly failures: number
  /** Gave up reading: «status unknown — check the tracker», with «Retry polling». */
  readonly lost: boolean
}

export const sendIdOf = (key: SendKey): string => `${key.applicationId}/${key.kind}`
const same = (a: SendKey, b: SendKey): boolean => sendIdOf(a) === sendIdOf(b)

export const isPolling = (send: TrackedSend): boolean => !send.line.final

const sending = (key: SendKey): TrackedSend => ({
  key,
  line: sendLine({ kind: key.kind, state: 'sending', at: '', reason: null }, key.company),
  failures: 0,
  lost: false,
})

const evictable = (send: TrackedSend): boolean => send.line.final && send.line.tone === 'ok'

/** Drops the oldest final ok lines while the bar holds more than `max`; nothing else is ever dropped. */
export function trimmed(sends: readonly TrackedSend[], max: number = MAX_LINES): readonly TrackedSend[] {
  const extra = sends.length - max
  if (extra <= 0) return sends
  const drop = new Set(sends.filter(evictable).slice(0, extra))
  return drop.size === 0 ? sends : sends.filter((send) => !drop.has(send))
}

function replaced(sends: readonly TrackedSend[], key: SendKey, change: (send: TrackedSend) => TrackedSend): readonly TrackedSend[] {
  const at = sends.findIndex((send) => same(send.key, key))
  const old = sends[at]
  if (old === undefined) return sends
  const next = change(old)
  if (next === old) return sends
  return trimmed(sends.map((send, n) => (n === at ? next : send)))
}

const sameLine = (a: SendLine, b: SendLine): boolean => a.text === b.text && a.tone === b.tone && a.final === b.final && a.retry === b.retry

/** Starts following a send just approved (or retried): a fresh «Sending…», at the end. */
export function tracked(sends: readonly TrackedSend[], key: SendKey): readonly TrackedSend[] {
  return trimmed([...sends.filter((send) => !same(send.key, key)), sending(key)])
}

/** What a read of `GET /a/:id/sends/:kind` does; the same list back when nothing changed. */
export function polled(sends: readonly TrackedSend[], key: SendKey, view: SendView): readonly TrackedSend[] {
  return replaced(sends, key, (send) => {
    const line = sendLine(view, send.key.company)
    if (sameLine(line, send.line) && send.failures === 0 && !send.lost) return send
    return { key: send.key, line, failures: 0, lost: false }
  })
}

/** A read that failed: one more in a row; at `MAX_POLL_FAILURES`, the line gives up and says so. */
export function pollFailed(sends: readonly TrackedSend[], key: SendKey): readonly TrackedSend[] {
  return replaced(sends, key, (send) => {
    const failures = send.failures + 1
    if (failures < MAX_POLL_FAILURES) return { ...send, failures }
    const line: SendLine = { text: `${send.key.company}: status unknown — check the tracker`, tone: 'ask', final: true, retry: false }
    return { key: send.key, line, failures, lost: true }
  })
}

/** «Retry polling»: back to «Sending…» and read again. */
export function repolled(sends: readonly TrackedSend[], key: SendKey): readonly TrackedSend[] {
  return replaced(sends, key, (send) => sending(send.key))
}

/** `POST …/retry` was refused: the reason, and «Retry» again. */
export function retryRefused(sends: readonly TrackedSend[], key: SendKey, reason: string): readonly TrackedSend[] {
  return replaced(sends, key, (send) => ({
    key: send.key,
    line: { text: `${send.key.company}: ${reason}`, tone: 'err', final: true, retry: true },
    failures: 0,
    lost: false,
  }))
}

/** «Dismiss»: the owner has read it. */
export function dismissed(sends: readonly TrackedSend[], key: SendKey): readonly TrackedSend[] {
  return sends.filter((send) => !same(send.key, key))
}
