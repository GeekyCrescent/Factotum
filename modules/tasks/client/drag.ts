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
 * Where it lands is decided by `dropAt` in `model.ts`; this only measures the screen — ONCE, when the
 * drag starts, and then shifts those boxes by what the board and the page scrolled. Measuring every
 * card on every pointer move, and re-rendering the board each time, is what a 2 000-card board cannot
 * afford (review of block K). The board re-renders only when the place under the pointer changes.
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

/** A column's box, and whether it scrolls with the board: the pinned rails stay put (redesign A). */
interface MeasuredColumn extends ColumnBox {
  readonly fixed: boolean
}

function measure(root: HTMLElement, strip: HTMLElement): { readonly columns: readonly MeasuredColumn[]; readonly cards: readonly CardBox[] } {
  const columns = Array.from(root.querySelectorAll<HTMLElement>('[data-column]')).map((element) => {
    const { left, right } = element.getBoundingClientRect()
    return { status: element.dataset['column'] as Column, left, right, fixed: !strip.contains(element) }
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
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

const sameDrop = (a: Drop | undefined, b: Drop | undefined): boolean => a?.status === b?.status && a?.index === b?.index

export function useBoardDrag(root: RefObject<HTMLElement>, onDrop: (id: string, drop: Drop) => void) {
  const [dragging, setDragging] = useState<Dragging | undefined>(undefined)
  const stop = useRef<(() => void) | undefined>(undefined)
  // The callback of the LATEST render: a read that lands mid-drag must not leave the drop computing
  // its neighbours from the columns of the render where the drag began.
  const dropped = useRef(onDrop)
  dropped.current = onDrop
  useEffect(() => () => stop.current?.(), [])

  const start = (id: string, event: PointerEvent): void => {
    const board = root.current
    // One drag at a time: a second finger on another grip is ignored.
    if (board === null || event.button !== 0 || stop.current !== undefined) return
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    const page = pageScroller(board)
    // What scrolls sideways: the columns' strip when the board has one, else the board itself.
    const strip = board.querySelector<HTMLElement>('[data-scroll]') ?? board
    const boxes = measure(board, strip)
    const origin = { left: strip.scrollLeft, top: page.scrollTop }
    const from = { x: event.clientX, y: event.clientY }
    let at = { ...from }
    let current: Dragging | undefined
    let frame = 0

    const locate = () => {
      const dx = strip.scrollLeft - origin.left
      const dy = page.scrollTop - origin.top
      const columns = boxes.columns.map((c) => (c.fixed ? c : { ...c, left: c.left - dx, right: c.right - dx }))
      const cards = boxes.cards.map((c) => ({ ...c, top: c.top - dy, bottom: c.bottom - dy }))
      const drop = dropAt(columns, cards, at.x, at.y, id)
      if (current !== undefined && sameDrop(current.drop, drop)) return
      current = { id, drop }
      setDragging(current)
    }

    const scroll = () => {
      frame = requestAnimationFrame(scroll)
      if (current === undefined) return
      const box = strip.getBoundingClientRect()
      // Only over the strip itself: over the pinned rails, past its right edge, nothing scrolls.
      const over = at.x >= box.left && at.x <= box.right
      const sideways = !over ? 0 : at.x < box.left + EDGE_PX ? -SCROLL_PX : at.x > box.right - EDGE_PX ? SCROLL_PX : 0
      const down = at.y < EDGE_PX ? -SCROLL_PX : at.y > window.innerHeight - EDGE_PX ? SCROLL_PX : 0
      const before = { left: strip.scrollLeft, top: page.scrollTop }
      strip.scrollLeft += sideways
      page.scrollTop += down
      // Only when something actually scrolled: at an edge with nowhere to go, nothing is recomputed.
      if (strip.scrollLeft !== before.left || page.scrollTop !== before.top) locate()
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
      if (commit && current?.drop !== undefined) dropped.current(current.id, current.drop)
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
