/**
 * Dragging a project or a category by its grip, with a mouse or a finger alike (pointer events).
 *
 * NO LIBRARY: the drawer needs one list sorted by one handle, and a drag-and-drop package is the
 * dependency this project avoids. What it would have given, and this does instead:
 *
 *  - ONLY THE GRIP starts a drag, and only it carries `touch-action: none` (client.css): anywhere
 *    else a finger still scrolls the drawer, a tap still folds, and a long press still opens the menu.
 *  - Nothing moves while dragging. The rows stay put and a line shows where it will land; the
 *    layout changes once, on release. So there is no DOM moved under the pointer and no flicker.
 *  - Near the top or the bottom of the drawer, it scrolls, so a long list can be crossed.
 *  - Escape, or the browser taking the pointer back, cancels it.
 *
 * Where it lands is decided by the pure functions in `layout.ts`; this only measures the screen.
 */

import type { RefObject } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { categoryIndexAt, dropAt, type Drop, type Target } from './layout.ts'

/** How far the pointer moves before a press on the grip is a drag and not a tap. */
const START_PX = 4
/** How close to an edge of the drawer the pointer has to be for it to scroll, and how fast. */
const EDGE_PX = 48
const SCROLL_PX = 10

export type Dragging =
  | { readonly kind: 'project'; readonly id: string; readonly drop: Drop | undefined }
  /** `index`: among the OTHER categories, where it lands. */
  | { readonly kind: 'category'; readonly id: string; readonly index: number | undefined }

function measureProjects(root: HTMLElement): readonly Target[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-target]')).flatMap((element): Target[] => {
    const { top, bottom } = element.getBoundingClientRect()
    const id = element.dataset['id'] ?? ''
    switch (element.dataset['target']) {
      case 'project':
        return [{ kind: 'project', id, top, bottom }]
      case 'category':
        return [{ kind: 'category', id, top, bottom }]
      case 'loose':
        return [{ kind: 'loose', top, bottom }]
      default:
        return []
    }
  })
}

function categoryMids(root: HTMLElement, dragged: string): readonly number[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-category-block]'))
    .filter((element) => element.dataset['categoryBlock'] !== dragged)
    .map((element) => {
      const box = element.getBoundingClientRect()
      return (box.top + box.bottom) / 2
    })
}

/** The element that scrolls the drawer: the shell's, so it is found rather than named. */
function scrollerOf(element: HTMLElement): HTMLElement | undefined {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return undefined
}

export function useDrag(root: RefObject<HTMLElement>, onDrop: (drag: Dragging) => void) {
  const [dragging, setDragging] = useState<Dragging | undefined>(undefined)
  const stop = useRef<(() => void) | undefined>(undefined)
  // A drag in flight is cancelled when the drawer goes away.
  useEffect(() => () => stop.current?.(), [])

  const start = (kind: Dragging['kind'], id: string, event: PointerEvent): void => {
    const container = root.current
    if (container === null || event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    const scroller = scrollerOf(container)
    const fromY = event.clientY
    let y = event.clientY
    let current: Dragging | undefined
    let frame = 0

    const locate = () => {
      current =
        kind === 'project'
          ? { kind, id, drop: dropAt(measureProjects(container), y, id) }
          : { kind, id, index: categoryIndexAt(categoryMids(container, id), y) }
      setDragging(current)
    }

    const scroll = () => {
      frame = requestAnimationFrame(scroll)
      if (current === undefined || scroller === undefined) return
      const box = scroller.getBoundingClientRect()
      const step = y < box.top + EDGE_PX ? -SCROLL_PX : y > box.bottom - EDGE_PX ? SCROLL_PX : 0
      if (step === 0) return
      scroller.scrollTop += step
      locate()
    }

    const move = (moved: PointerEvent) => {
      y = moved.clientY
      if (current === undefined && Math.abs(y - fromY) < START_PX) return
      locate()
    }

    const end = (commit: boolean) => {
      stop.current = undefined
      cancelAnimationFrame(frame)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', cancel)
      handle.removeEventListener('lostpointercapture', cancel)
      window.removeEventListener('keydown', key)
      setDragging(undefined)
      if (commit && current !== undefined) onDrop(current)
    }
    const up = () => end(true)
    const cancel = () => end(false)
    const key = (pressed: KeyboardEvent) => {
      if (pressed.key === 'Escape') end(false)
    }

    stop.current = cancel
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', cancel)
    handle.addEventListener('lostpointercapture', cancel)
    window.addEventListener('keydown', key)
    frame = requestAnimationFrame(scroll)
  }

  return { dragging, start }
}
