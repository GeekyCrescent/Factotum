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

import type { SendKind, SendNeed, SendState, SendView, UnknownAnswer } from './contract.ts'
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
  /** The last state read; null when none is known (lost). What the card offers comes from it. */
  readonly state: SendState | null
}

export const sendIdOf = (key: SendKey): string => `${key.applicationId}/${key.kind}`
const same = (a: SendKey, b: SendKey): boolean => sendIdOf(a) === sendIdOf(b)

export const isPolling = (send: TrackedSend): boolean => !send.line.final

const SEND_STATES: ReadonlySet<string> = new Set<SendState>(['sending', 'sent', 'send-unknown', 'failed'])

/** The `state` a decision answered, when it is a send's; null otherwise. */
export function sendStateOf(state: string | undefined): SendState | null {
  return state !== undefined && SEND_STATES.has(state) ? (state as SendState) : null
}

const sending = (key: SendKey, state: SendState = 'sending'): TrackedSend => ({
  key,
  line: sendLine({ kind: key.kind, state, at: '', reason: null }, key.company),
  failures: 0,
  lost: false,
  state,
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

/**
 * Starts following a send just approved (or retried), at the end: with the state the decision answered
 * — an approve may come back `failed` at once — or «Sending…» when it said none.
 */
export function tracked(sends: readonly TrackedSend[], key: SendKey, state: SendState | null = null): readonly TrackedSend[] {
  return trimmed([...sends.filter((send) => !same(send.key, key)), sending(key, state ?? 'sending')])
}

/**
 * The sends the tracker brings (`GET /overview` `sends`) as cards, after those already followed; a send
 * already followed is left as it is. The same list back when there is nothing new.
 */
export function seeded(sends: readonly TrackedSend[], needs: readonly SendNeed[]): readonly TrackedSend[] {
  const known = new Set(sends.map((send) => sendIdOf(send.key)))
  const fresh = needs
    .map((need): TrackedSend => {
      const key: SendKey = { applicationId: need.applicationId, kind: need.kind, company: need.company }
      return { key, line: sendLine({ kind: need.kind, state: need.state, at: need.at, reason: need.reason }, need.company), failures: 0, lost: false, state: need.state }
    })
    .filter((send) => !known.has(sendIdOf(send.key)))
  return fresh.length === 0 ? sends : [...sends, ...fresh]
}

/** What a read of `GET /a/:id/sends/:kind` does; the same list back when nothing changed. */
export function polled(sends: readonly TrackedSend[], key: SendKey, view: SendView): readonly TrackedSend[] {
  return replaced(sends, key, (send) => {
    const line = sendLine(view, send.key.company)
    if (sameLine(line, send.line) && send.failures === 0 && !send.lost && send.state === view.state) return send
    return { key: send.key, line, failures: 0, lost: false, state: view.state }
  })
}

/** A read that failed: one more in a row; at `MAX_POLL_FAILURES`, the line gives up and says so. */
export function pollFailed(sends: readonly TrackedSend[], key: SendKey): readonly TrackedSend[] {
  return replaced(sends, key, (send) => {
    const failures = send.failures + 1
    if (failures < MAX_POLL_FAILURES) return { ...send, failures }
    const line: SendLine = { text: `${send.key.company}: status unknown — check the tracker`, tone: 'ask', final: true, retry: false }
    return { key: send.key, line, failures, lost: true, state: null }
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
    state: 'failed',
  }))
}

/** An answer to «did it go?» (or «Mark as sent») was refused: why, in red, and the same choices. */
export function answerRefused(sends: readonly TrackedSend[], key: SendKey, reason: string): readonly TrackedSend[] {
  return replaced(sends, key, (send) => ({ ...send, line: { ...send.line, text: `${send.key.company}: ${reason}`, tone: 'err', final: true } }))
}

// ── What a send's card offers (D9; v6 M2) ────────────────────────────────────────────────────────

export type SendAction = UnknownAnswer | 'retry'

const KIND_LABELS: Readonly<Record<SendKind, string>> = { 'initial': 'Initial email', 'followup-1': 'Follow-up 1', 'followup-2': 'Follow-up 2' }

/** «Initial email», «Follow-up 1»: which send a card is about. */
export const kindLabel = (kind: SendKind): string => KIND_LABELS[kind]

/**
 * A failed send: «Retry». One whose fate is unknown: «It went», «Send again», and on the initial «It
 * didn't go» (a follow-up's is the tracker's, only once the application has a reply, v5 X9). A line
 * that lost its reads offers none: whether it went is exactly what is unknown.
 */
export function actionsOf(send: TrackedSend): readonly { readonly action: SendAction; readonly label: string }[] {
  if (send.lost) return []
  if (send.state === 'failed') return [{ action: 'retry', label: 'Retry' }]
  if (send.state !== 'send-unknown') return []
  const both = [
    { action: 'went', label: 'It went' },
    { action: 'again', label: 'Send again' },
  ] as const
  return send.key.kind === 'initial' ? [...both, { action: 'not-went', label: 'It didn’t go' }] : both
}

/** «Dismiss»: the owner has read it. */
export function dismissed(sends: readonly TrackedSend[], key: SendKey): readonly TrackedSend[] {
  return sends.filter((send) => !same(send.key, key))
}
