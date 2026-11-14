/**
 * A rewritten item, as data (spec 2026-11-12-postulaciones, design D15 «Reescrita»; requirements
 * crit. 30, 32; A4). Pure: `rewritten.tsx` draws what this says.
 *
 * BACK: the tag «rewritten · "<instruction>"», the word diff of the text before against the text now,
 * and «212 → 158 words». FAILED (three tries, A4): «rewrite failed · "<instruction>"» with the short
 * reason, the version before with no diff, and «Try again» with the same instruction in the box.
 */

import type { ReviewItem, RewriteInfo } from './contract.ts'
import { countLine, wordDiff, type DiffPart } from './diff.ts'

export interface RewrittenView {
  readonly tag: string
  readonly failed: boolean
  readonly reason: string | null
  /** null: nothing to compare (failed, or a text missing). */
  readonly parts: readonly DiffPart[] | null
  readonly count: string | null
  /** «Try again» writes this in the box; null = no «Try again». */
  readonly retry: string | null
}

export function rewrittenView(rewrite: RewriteInfo, after: string | null): RewrittenView {
  const quoted = rewrite.instruction === null ? '' : ` · “${rewrite.instruction}”`
  if (rewrite.failed) {
    return { tag: `rewrite failed${quoted}`, failed: true, reason: rewrite.reason, parts: null, count: null, retry: rewrite.instruction }
  }
  const comparable = rewrite.before !== null && after !== null
  return {
    tag: `rewritten${quoted}`,
    failed: false,
    reason: null,
    parts: comparable ? wordDiff(rewrite.before ?? '', after ?? '') : null,
    count: comparable ? countLine(rewrite.before ?? '', after ?? '') : null,
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
