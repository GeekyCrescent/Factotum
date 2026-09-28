/**
 * The 300 ms guard on Allow and Deny (spec 2026-09-18, design D6; criterion 21).
 *
 * A sheet that slides up under a finger already on its way down turns a tap meant for something
 * else into an answer. So a POINTER press that started less than 300 ms after the sheet became
 * visible does not count. The KEYBOARD always counts: nobody presses Enter by accident on a sheet
 * that just appeared under their thumb. Pure, with `now` injected, so a test drives the clock.
 */

export const GUARD_MS = 300

export interface Guard {
  /** Call once, in the first animation frame after the sheet mounts. */
  readonly shown: () => void
  /** `pointerDownAt`: when the pointerdown before this click happened, or `undefined` (keyboard). */
  readonly accepts: (pointerDownAt: number | undefined) => boolean
}

export function createGuard(now: () => number, ms: number = GUARD_MS): Guard {
  let shownAt: number | undefined
  return {
    shown: () => {
      shownAt = now()
    },
    accepts: (pointerDownAt) => {
      if (pointerDownAt === undefined) return true
      return shownAt !== undefined && pointerDownAt - shownAt >= ms
    },
  }
}
