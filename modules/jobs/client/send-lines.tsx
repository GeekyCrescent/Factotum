/**
 * One card per send (design D9, D15; requirements crit. 41, 38b): «Initial email · Sending to Acme…»
 * → «Sent ✓», or the reason with «Retry», or «did it go?» with «It went» / «Send again» / «It didn't
 * go» (the initial's, v6 M2). What each card offers is `sends-model.ts` `actionsOf`; the posting, and
 * the lock it goes through, are `use-sends.ts`'s.
 *
 * «Send again» and «It didn't go» ask for a second click (`arm.ts`), and the arm holds only on the card
 * it was set on (`cardOf`): a row that moved under the finger has to be confirmed again.
 */

import { useEffect, useState } from 'preact/hooks'
import { ARM_EXPIRY_MS, armOn, pressArmed, type Arm } from './arm.ts'
import { actionsOf, cardOf, kindLabel, sendIdOf, type SendAction, type SendOffer } from './sends-model.ts'
import type { SendsState, TrackedSend } from './use-sends.ts'

export function SendLines({ sends, busy }: { readonly sends: SendsState; readonly busy: boolean }) {
  if (sends.sends.length === 0) return null
  return (
    <ul class="j-sends">
      {sends.sends.map((send) => (
        <SendCard key={sendIdOf(send.key)} send={send} sends={sends} busy={busy} />
      ))}
    </ul>
  )
}

function SendCard({ send, sends, busy }: { readonly send: TrackedSend; readonly sends: SendsState; readonly busy: boolean }) {
  const [armed, setArmed] = useState<{ readonly action: SendAction; readonly arm: Arm } | null>(null)
  const card = cardOf(send)
  const armedAt = (action: SendAction): number | null => (armed?.action === action ? armOn(armed.arm, card) : null)
  // The arm goes by itself after ARM_EXPIRY_MS (`arm.ts`).
  useEffect(() => {
    if (armed === null) return
    const timer = setTimeout(() => setArmed(null), Math.max(0, armed.arm.at + ARM_EXPIRY_MS - Date.now()))
    return () => clearTimeout(timer)
  }, [armed])
  const press = (offer: SendOffer): void => {
    if (offer.confirm === null) {
      void sends.act(send.key, offer.action)
      return
    }
    const next = pressArmed(armedAt(offer.action), Date.now())
    setArmed(next.armedAt === null ? null : { action: offer.action, arm: { at: next.armedAt, on: card } })
    if (next.fire) void sends.act(send.key, offer.action)
  }
  const what = `${kindLabel(send.key.kind)} to ${send.key.company}`
  return (
    <li class={`j-send ${send.line.tone}`}>
      <span class="j-send-text" role="status">
        <span class="j-send-kind">{kindLabel(send.key.kind)}</span> · {send.line.text}
      </span>
      <span class="j-send-acts">
        {actionsOf(send).map((offer) => {
          const isArmed = armedAt(offer.action) !== null
          return (
            <button
              key={offer.action}
              type="button"
              class={`btn sm${isArmed ? ' primary' : ''}`}
              disabled={busy}
              aria-label={`${isArmed && offer.confirm !== null ? offer.confirm : offer.label}: ${what}`}
              onClick={() => press(offer)}
              onBlur={() => setArmed(null)}
            >
              {isArmed && offer.confirm !== null ? offer.confirm : offer.label}
            </button>
          )
        })}
        {send.lost ? (
          <button type="button" class="btn sm quiet" aria-label={`Retry polling: ${what}`} onClick={() => sends.repoll(send.key)}>
            Retry polling
          </button>
        ) : null}
        {send.line.final && send.line.tone !== 'ok' ? (
          <button type="button" class="btn sm quiet" aria-label={`Dismiss: ${what}`} onClick={() => sends.dismiss(send.key)}>
            Dismiss
          </button>
        ) : null}
      </span>
    </li>
  )
}
