/**
 * Which area of the dock may open its overlay BY ITSELF (spec 2026-10-01-preguntas-con-opciones, D12).
 * Pure.
 *
 * The router holds one overlay. Before this, every area opened itself when it mounted, so an ask that
 * arrived while the owner was filling in a batch of questions took the screen away from them. Now it is
 * decided ONCE, ON ARRIVAL, and never revisited: with a decision already open, the newcomer stays a
 * notice in the dock until the owner taps it — also after the other one closes. Nothing opens itself
 * over something the owner just closed.
 *
 * What makes that true is the area's effect, not this function: it keeps a ref of "already decided",
 * sets it the first time it runs WHETHER OR NOT it opened, and does not call `setOverlay` again.
 */

/**
 * The overlays that ARE a decision. The drawer is not: an ask that arrives with the drawer open replaces
 * it, as it always has (`use-route.ts`). Changing that would change the ask's flow, which is out of scope.
 */
export const DECISION_OVERLAYS: ReadonlySet<string> = new Set(['ask', 'questions'])

/** Decided once, on arrival: open now, or stay a notice. */
export function mayOpenItself(current: string | undefined, alreadyDecided: boolean): boolean {
  if (alreadyDecided) return false
  return current === undefined || !DECISION_OVERLAYS.has(current)
}
