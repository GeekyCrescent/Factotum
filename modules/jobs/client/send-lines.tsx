/**
 * One card per send (design D9, D15; requirements crit. 41, 38b): «Initial email · Sending to Acme…»
 * → «Sent ✓», or the reason with «Retry», or «did it go?» with «It went» / «Send again» / «It didn't
 * go» (the initial's, v6 M2). What each card offers is `sends-model.ts` `actionsOf`; the posting, and
 * the lock it goes through, are `use-sends.ts`'s. Used by the batch bar and by the tracker.
 */

import { actionsOf, kindLabel, sendIdOf } from './sends-model.ts'
import type { SendsState } from './use-sends.ts'

export function SendLines({ sends, busy }: { readonly sends: SendsState; readonly busy: boolean }) {
  if (sends.sends.length === 0) return null
  return (
    <ul class="j-sends" role="status">
      {sends.sends.map((send) => (
        <li key={sendIdOf(send.key)} class={`j-send ${send.line.tone}`}>
          <span class="j-send-text">
            <span class="j-send-kind">{kindLabel(send.key.kind)}</span> · {send.line.text}
          </span>
          <span class="j-send-acts">
            {actionsOf(send).map((action) => (
              <button key={action.action} type="button" class="btn sm" disabled={busy} onClick={() => void sends.act(send.key, action.action)}>
                {action.label}
              </button>
            ))}
            {send.lost ? (
              <button type="button" class="btn sm quiet" onClick={() => sends.repoll(send.key)}>
                Retry polling
              </button>
            ) : null}
            {send.line.final && send.line.tone !== 'ok' ? (
              <button type="button" class="btn sm quiet" onClick={() => sends.dismiss(send.key)}>
                Dismiss
              </button>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}
