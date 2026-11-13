/**
 * «Send anyway» asks twice (T-D5): the first click arms it, a second confirms. Pure.
 *
 * A DOUBLE TAP IS ONE INTENTION, not two: a second click within `ARM_GRACE_MS` of the first is ignored,
 * so the confirmation has to be a separate, later click. An arm left alone goes away after
 * `ARM_EXPIRY_MS` (and on blur, which is the component's), so a stray click minutes later does not send.
 */

/** A second click sooner than this after arming is the same tap, not a confirmation. */
export const ARM_GRACE_MS = 500
/** An arm older than this is gone. */
export const ARM_EXPIRY_MS = 4_000

export interface Press {
  /** Send now. */
  readonly fire: boolean
  /** When it was armed; null = not armed. */
  readonly armedAt: number | null
}

export function isArmed(armedAt: number | null, now: number): boolean {
  return armedAt !== null && now - armedAt < ARM_EXPIRY_MS
}

/** One click on «Send anyway», armed at `armedAt` (or not), at `now`. */
export function pressArmed(armedAt: number | null, now: number): Press {
  if (armedAt === null || !isArmed(armedAt, now)) return { fire: false, armedAt: now }
  if (now - armedAt < ARM_GRACE_MS) return { fire: false, armedAt }
  return { fire: true, armedAt: null }
}
