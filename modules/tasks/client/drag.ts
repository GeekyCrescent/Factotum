/**
 * Dragging a card by its grip, in TWO AXES: the column by `clientX`, the place by `clientY` (design
 * D11). The pattern of the sessions module's drawer drag, written again here (criterion 44):
 *
 *  - ONLY THE GRIP starts a drag, and only it carries `touch-action: none`: anywhere else a tap opens
 *    the card. On the phone there is no grip at all — «Move to…» does it (criterion 7).
 *  - Nothing moves while dragging. A line shows where the card will land; the board changes once, on
 *    release.
 *  - Near an edge of the board it scrolls, sideways and down, so a long column can be crossed.
 *  - Escape, or the browser taking the pointer back, cancels it.
 *
 * Where it lands is decided by `dropAt` in `model.ts`; this only measures the screen.
 */

import type { RefObject } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { dropAt, type CardBox, type Column, type ColumnBox, type Drop } from './model.ts'

/** How far the pointer moves before a press on the grip is a drag and not a tap. */
const START_PX = 4
/** How close to an edge the pointer has to be for the board to scroll, and how fast. */
const EDGE_PX = 48
const SCROLL_PX = 12

export interface Dragging {
  readonly id: string
  readonly drop: Drop | undefined
}

function measure(root: HTMLElement): { readonly columns: readonly ColumnBox[]; readonly cards: readonly CardBox[] } {
  const columns = Array.from(root.querySelectorAll<HTMLElement>('[data-column]')).map((element) => {
    const { left, right } = element.getBoundingClientRect()
    return { status: element.dataset['column'] as Column, left, right }
  })
  const cards = Array.from(root.querySelectorAll<HTMLElement>('[data-card]')).map((element) => {
    const { top, bottom } = element.getBoundingClientRect()
    return { id: element.dataset['card'] ?? '', status: element.dataset['status'] as Column, top, bottom }
  })
  return { columns, cards }
}

/** The element that scrolls the page vertically: the shell's, so it is found rather than named. */
function pageScroller(element: HTMLElement): HTMLElement {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return document.scrollingElement as HTMLElement
}

export function useBoardDrag(root: RefObject<HTMLElement>, onDrop: (id: string, drop: Drop) => void) {
  const [dragging, setDragging] = useState<Dragging | undefined>(undefined)
  const stop = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => stop.current?.(), [])

  const start = (id: string, event: PointerEvent): void => {
    const board = root.current
    if (board === null || event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    const page = pageScroller(board)
    const from = { x: event.clientX, y: event.clientY }
    let at = { ...from }
    let current: Dragging | undefined
    let frame = 0

    const locate = () => {
      const { columns, cards } = measure(board)
      current = { id, drop: dropAt(columns, cards, at.x, at.y, id) }
      setDragging(current)
    }

    const scroll = () => {
      frame = requestAnimationFrame(scroll)
      if (current === undefined) return
      const box = board.getBoundingClientRect()
      const sideways = at.x < box.left + EDGE_PX ? -SCROLL_PX : at.x > box.right - EDGE_PX ? SCROLL_PX : 0
      const down = at.y < EDGE_PX ? -SCROLL_PX : at.y > window.innerHeight - EDGE_PX ? SCROLL_PX : 0
      if (sideways === 0 && down === 0) return
      board.scrollLeft += sideways
      page.scrollTop += down
      locate()
    }

    const move = (moved: PointerEvent) => {
      at = { x: moved.clientX, y: moved.clientY }
      if (current === undefined && Math.hypot(at.x - from.x, at.y - from.y) < START_PX) return
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
      if (commit && current?.drop !== undefined) onDrop(current.id, current.drop)
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
