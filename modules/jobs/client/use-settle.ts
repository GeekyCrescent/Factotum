/**
 * The settle of the card on screen (design D15 «Lo que se vio es lo que se aprueba»; `guard.ts`).
 *
 * `view` names what the card shows. When it changes, the moment is noted IN THE RENDER that draws it
 * — not in an effect, which would leave one frame where the old «settled» enables the new card's
 * buttons — and a timer draws again once `SETTLE_MS` has passed, so the buttons come on by themselves.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { canDecide, settleLeft } from './guard.ts'

export interface Settle {
  /** For drawing: the buttons are on. */
  readonly settled: boolean
  /** For an event: read the clock now, not at the last render. */
  readonly ready: () => boolean
}

export function useSettle(view: string): Settle {
  const shown = useRef<{ readonly view: string; readonly at: number } | undefined>(undefined)
  if (shown.current?.view !== view) shown.current = { view, at: Date.now() }
  const at = shown.current.at
  const [, redraw] = useState(0)
  const left = settleLeft(at, Date.now())

  useEffect(() => {
    if (left === 0) return
    const timer = setTimeout(() => redraw((n) => n + 1), left)
    return () => clearTimeout(timer)
  }, [view, left])

  const ready = useCallback(() => canDecide(shown.current?.at ?? Date.now(), Date.now()), [])
  return { settled: left === 0, ready }
}
