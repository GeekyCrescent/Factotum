/**
 * «Skip» asks why (spec 2026-11-12-postulaciones, design D15; requirements crit. 30): not now, not a
 * fit (which closes the application, T-A22), duplicate, or other with a few words. What each reason
 * posts is `skip-model.ts`'s.
 *
 * THE SAME GUARD AS ANY DECISION: the choice goes through `onChoose`, which is the review's `send` —
 * the one lock, the `seen` of the card the sheet was opened on. The review closes the sheet when that
 * card changes under it, so a choice is never made on a card the owner did not see.
 */

import { useState } from 'preact/hooks'
import type { Decision, SkipReason } from './contract.ts'
import { Sheet } from './sheet.tsx'
import { MAX_SKIP_TEXT, skipDecision, skipReasonsFor } from './skip-model.ts'

export interface SkipSheetProps {
  readonly entity: 'application' | 'followup'
  readonly company: string
  readonly busy: boolean
  /** Posts the skip; resolves with whether it went through. */
  readonly onChoose: (decision: Omit<Decision, 'itemId' | 'seen'>) => Promise<boolean>
  readonly onClose: () => void
}

export function SkipSheet({ entity, company, busy, onChoose, onClose }: SkipSheetProps) {
  const [other, setOther] = useState<string | null>(null)
  const [why, setWhy] = useState<string | null>(null)
  const choose = async (reason: SkipReason, text: string) => {
    const outcome = skipDecision(reason, text)
    if (!outcome.ok) {
      setWhy(outcome.why)
      return
    }
    if (await onChoose(outcome.decision)) onClose()
  }
  return (
    <Sheet id="j-skip-title" title={`Skip ${company}`} onClose={onClose}>
      <ul class="j-choices">
        {skipReasonsFor(entity).map((choice) => (
          <li key={choice.reason}>
            <button
              type="button"
              class={`btn j-choice${choice.closes ? ' j-closes' : ''}`}
              disabled={busy}
              onClick={() => (choice.reason === 'other' ? setOther(other ?? '') : void choose(choice.reason, ''))}
            >
              <span>{choice.label}</span>
              <span class="j-choice-note">{choice.note}</span>
            </button>
          </li>
        ))}
      </ul>
      {other === null ? null : (
        <form
          class="j-other"
          onSubmit={(event) => {
            event.preventDefault()
            void choose('other', other)
          }}
        >
          <label class="j-field">
            <span>Why</span>
            <input
              class="j-input"
              autofocus
              maxLength={MAX_SKIP_TEXT}
              value={other}
              onInput={(event) => {
                setOther(event.currentTarget.value)
                setWhy(null)
              }}
            />
          </label>
          <button type="submit" class="btn primary" disabled={busy}>
            Skip
          </button>
        </form>
      )}
      {why === null ? null : (
        <p class="j-error" role="alert">
          {why}
        </p>
      )}
    </Sheet>
  )
}
