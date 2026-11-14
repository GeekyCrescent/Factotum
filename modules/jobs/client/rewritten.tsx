/**
 * A rewritten item (spec 2026-11-12-postulaciones, design D15 «Reescrita»; requirements crit. 30,
 * 32; A4): the tag «rewritten · "<instruction>"», the word diff (`.add` green, `.del` struck through
 * in red) and «212 → 158 words». FAILED: «rewrite failed · "<instruction>"» with its reason, no diff
 * (the card below shows the version before), and «Try again» with the instruction already in the box.
 * What to draw is `rewrite-model.ts`'s.
 */

import type { ReviewItem, RewriteInfo } from './contract.ts'
import { afterTextOf, rewrittenView } from './rewrite-model.ts'

export interface RewrittenProps {
  readonly item: ReviewItem
  readonly rewrite: RewriteInfo
  readonly decided: boolean
  /** Writes the instruction in the box and focuses it. */
  readonly onTryAgain: (instruction: string) => void
}

export function Rewritten({ item, rewrite, decided, onTryAgain }: RewrittenProps) {
  const view = rewrittenView(rewrite, afterTextOf(item))
  return (
    <section class={`j-rewritten${view.failed ? ' failed' : ''}`} aria-label="The rewrite">
      <p class="j-rewrite-tag">
        {view.tag}
        {view.reason === null ? null : <span class="j-quiet"> · {view.reason}</span>}
      </p>
      {view.count === null ? null : <p class="j-quiet">{view.count}</p>}
      {view.parts === null ? null : (
        <p class="j-text j-diff">
          {view.parts.map((part, at) =>
            part.kind === 'same' ? (
              <span key={at}>{part.text}</span>
            ) : part.kind === 'add' ? (
              <ins key={at} class="add">
                {part.text}
              </ins>
            ) : (
              <del key={at} class="del">
                {part.text}
              </del>
            ),
          )}
        </p>
      )}
      {view.retry === null || decided ? null : (
        <button type="button" class="btn sm" onClick={() => onTryAgain(view.retry ?? '')}>
          Try again
        </button>
      )}
    </section>
  )
}
