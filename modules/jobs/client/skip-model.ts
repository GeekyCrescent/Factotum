/**
 * The skip sheet, as data (spec 2026-11-12-postulaciones, design D15; requirements crit. 30). Pure.
 *
 * THE REASONS are the engine's tokens (`not-now`, `not-a-fit`, `duplicate`, `other`). «Not a fit»
 * CLOSES the application (T-A22), so the sheet says so; the others leave it where it is and take it
 * out of today's batches. A follow-up is offered none that closes: what «not a fit» means for the
 * application behind it is not a follow-up's call.
 */

import type { Decision, SkipReason } from './contract.ts'

/** The longest «other» the sheet posts; the engine has the last word. */
export const MAX_SKIP_TEXT = 300

export interface SkipChoice {
  readonly reason: SkipReason
  readonly label: string
  /** What it does, under the button. */
  readonly note: string
  readonly closes: boolean
}

const CHOICES: readonly SkipChoice[] = [
  { reason: 'not-now', label: 'Not now', note: 'It comes back in a later batch.', closes: false },
  { reason: 'not-a-fit', label: 'Not a fit', note: 'Closes this application.', closes: true },
  { reason: 'duplicate', label: 'Duplicate', note: 'Already applied another way.', closes: false },
  { reason: 'other', label: 'Other…', note: 'Say why in a few words.', closes: false },
]

const FOLLOWUP: ReadonlySet<SkipReason> = new Set<SkipReason>(['not-now', 'other'])

export function skipReasonsFor(entity: 'application' | 'followup'): readonly SkipChoice[] {
  return entity === 'application' ? CHOICES : CHOICES.filter((choice) => FOLLOWUP.has(choice.reason))
}

export type SkipOutcome =
  | { readonly ok: true; readonly decision: Omit<Decision, 'itemId' | 'seen'> }
  | { readonly ok: false; readonly why: string }

/** The decision a choice posts; «other» needs its words, trimmed, and no more than `MAX_SKIP_TEXT`. */
export function skipDecision(reason: SkipReason, text: string): SkipOutcome {
  if (reason !== 'other') return { ok: true, decision: { kind: 'skip', reason } }
  const words = text.trim()
  if (words === '') return { ok: false, why: 'Say why in a few words' }
  if (words.length > MAX_SKIP_TEXT) return { ok: false, why: `At most ${MAX_SKIP_TEXT} characters` }
  return { ok: true, decision: { kind: 'skip', reason, text: words } }
}
