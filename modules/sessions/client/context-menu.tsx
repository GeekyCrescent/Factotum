/**
 * A menu at the pointer: right-click on a computer, a long press on a phone (spec 2026-09-30). It
 * closes on a choice, on Escape, on a click anywhere else, and when the page scrolls.
 *
 * Placed where the pointer was and pulled back inside the window, so it never opens off-screen.
 */

import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

/** How long a finger has to stay down for a long press. */
export const LONG_PRESS_MS = 500
/** How far a finger may drift before it is a scroll, not a press. */
const DRIFT_PX = 10

export interface MenuAt {
  readonly x: number
  readonly y: number
}

export function ContextMenu({ at, onClose, children }: { readonly at: MenuAt; readonly onClose: () => void; readonly children: ComponentChildren }) {
  const menu = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState(at)

  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect()
    if (box === undefined) return
    const margin = 8
    setPlace({
      x: Math.max(margin, Math.min(at.x, window.innerWidth - box.width - margin)),
      y: Math.max(margin, Math.min(at.y, window.innerHeight - box.height - margin)),
    })
  }, [at])

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const outside = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) onClose()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    // On the next turn: the press that opened the menu must not close it.
    const timer = setTimeout(() => {
      document.addEventListener('pointerdown', outside, true)
      document.addEventListener('scroll', onClose, true)
    }, 0)
    window.addEventListener('keydown', key)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('scroll', onClose, true)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])

  return (
    <div
      class="s-ctx"
      role="menu"
      ref={menu}
      style={{ left: `${place.x}px`, top: `${place.y}px` }}
      // A choice closes it: the item's own handler runs first, then this sees the click bubble up.
      onClick={(event) => {
        if ((event.target as Element).closest('button') !== null) onClose()
      }}
    >
      {children}
    </div>
  )
}

/**
 * The handlers that open the menu: `contextmenu` for a mouse (and for the long press of browsers
 * that send one), and a timer for a finger, since Safari on iOS sends no `contextmenu`. After a long
 * press, the click that follows is swallowed, so the row does not also open.
 */
export function useLongPress(open: (at: MenuAt) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const start = useRef<MenuAt | undefined>(undefined)
  const fired = useRef(false)

  const cancel = () => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
  }

  return {
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault()
      if (fired.current) return
      open({ x: event.clientX, y: event.clientY })
    },
    onPointerDown: (event: PointerEvent) => {
      fired.current = false
      if (event.pointerType === 'mouse') return
      start.current = { x: event.clientX, y: event.clientY }
      cancel()
      timer.current = setTimeout(() => {
        fired.current = true
        if (start.current !== undefined) open(start.current)
      }, LONG_PRESS_MS)
    },
    onPointerMove: (event: PointerEvent) => {
      const from = start.current
      if (from !== undefined && Math.hypot(event.clientX - from.x, event.clientY - from.y) > DRIFT_PX) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    /** True once, for the click that ends a long press: the caller ignores that click. */
    swallow: (): boolean => {
      const was = fired.current
      fired.current = false
      return was
    },
  }
}
