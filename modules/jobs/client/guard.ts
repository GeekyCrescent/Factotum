/**
 * What was seen is what is approved (spec 2026-11-12-postulaciones, design D15 «Lo que se vio es lo
 * que se aprueba»). Pure, no DOM: the screen asks these before it posts a decision.
 *
 * THE SETTLE: a card just put on screen — a new item, or the same item changed under the finger —
 * takes no Approve and no Skip for `SETTLE_MS`, so a double tap or a held key that outlives one round
 * trip never decides the NEXT card without it being seen.
 */

/** How long a card just shown refuses Approve and Skip. */
export const SETTLE_MS = 700

/** The card shown at `shownAt` (ms) takes a decision at `now` (ms). A clock gone backwards does not unlock it. */
export function canDecide(shownAt: number, now: number): boolean {
  return now - shownAt >= SETTLE_MS
}

/** How long, in ms, until the card shown at `shownAt` takes a decision; 0 when it already does. */
export function settleLeft(shownAt: number, now: number): number {
  const elapsed = now - shownAt
  if (elapsed < 0) return SETTLE_MS
  return Math.max(0, SETTLE_MS - elapsed)
}
