/**
 * A rewritten item, as data (spec 2026-11-12-postulaciones, design D15 «Reescrita»; requirements
 * crit. 30, 32; A4). Pure: `rewritten.tsx` draws what this says.
 *
 * BACK: the tag «rewritten · "<instruction>"», «212 → 158 words» and «Show changes». By default no
 * diff: the card's letter below already shows the new text clean, exactly as it would be sent.
 * «Show changes» draws the word diff of the text before against the text now (`diffParts`, every word
 * apart from its neighbour) with a one-line legend; «Hide changes» puts it away. FAILED (three tries, A4): «rewrite failed · "<instruction>"» with the short
 * reason, the version before with no diff, and «Try again» with the same instruction in the box.
 */

import type { ReviewItem, RewriteInfo } from './contract.ts'
import { countLine, diffParts, type DiffPart } from './diff.ts'

export interface RewrittenView {
  readonly tag: string
  readonly failed: boolean
  readonly reason: string | null
  /** null: changes hidden (the default), or nothing to compare (failed, or a text missing). */
  readonly parts: readonly DiffPart[] | null
  readonly count: string | null
  /** «Show changes» / «Hide changes»; null when there is nothing to compare. */
  readonly toggle: string | null
  /** «struck = removed, underlined = added», while the changes show. */
  readonly legend: string | null
  /** «Try again» writes this in the box; null = no «Try again». */
  readonly retry: string | null
}

export const SHOW_CHANGES = 'Show changes'
export const HIDE_CHANGES = 'Hide changes'
export const DIFF_LEGEND = 'struck = removed, underlined = added'

export function rewrittenView(rewrite: RewriteInfo, after: string | null, showChanges = false): RewrittenView {
  const quoted = rewrite.instruction === null ? '' : ` · “${rewrite.instruction}”`
  if (rewrite.failed) {
    return { tag: `rewrite failed${quoted}`, failed: true, reason: rewrite.reason, parts: null, count: null, toggle: null, legend: null, retry: rewrite.instruction }
  }
  const tag = `rewritten${quoted}`
  if (rewrite.before === null || after === null) {
    return { tag, failed: false, reason: null, parts: null, count: null, toggle: null, legend: null, retry: null }
  }
  return {
    tag,
    failed: false,
    reason: null,
    parts: showChanges ? diffParts(rewrite.before, after) : null,
    count: countLine(rewrite.before, after),
    toggle: showChanges ? HIDE_CHANGES : SHOW_CHANGES,
    legend: showChanges ? DIFF_LEGEND : null,
    retry: null,
  }
}

/** The text the card shows now, the one the diff compares against `before`. */
export function afterTextOf(item: ReviewItem): string | null {
  if (item.kind === 'application' || (item.kind === 'rewritten' && item.target === 'application')) {
    const app = item.application
    return app.channel === 'linkedin' ? (app.linkedin ?? app.letter?.body ?? null) : (app.letter?.body ?? null)
  }
  if (item.kind === 'followup' || item.kind === 'rewritten') return item.followup.body
  return null
}

/** «1 still rewriting…»; null when every rewrite of the batch came back. */
export function stillRewriting(count: number): string | null {
  return count === 0 ? null : `${count} still rewriting…`
}
