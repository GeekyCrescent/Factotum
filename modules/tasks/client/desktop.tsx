/**
 * The board on a wide screen (≥ 900 px, redesign A): the four working columns share the width, an
 * empty one folded to a rail; Done and Canceled are pinned at the right edge as rails that open their
 * column. Every column and rail carries `data-column`, so a card can be dropped on any of them —
 * dropping on the Done rail finishes a card without opening it.
 *
 * Only the columns scroll sideways (`data-scroll`), and only when even the folded board does not fit;
 * the pinned rails stay where they are.
 */

import type { ComponentChildren, RefObject } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import type { Task } from '../types.ts'
import { StatusGlyph } from './glyphs.tsx'
import { Icon } from './icon.tsx'
import { boardLayout, labelOf, PINNED, type Column, type Pinned } from './model.ts'

export function DesktopBoard({
  columns,
  opened,
  toggle,
  list,
  addTo,
  dropOn,
  rootRef,
}: {
  readonly columns: Readonly<Record<Column, readonly Task[]>>
  readonly opened: ReadonlySet<Pinned>
  readonly toggle: (status: Pinned) => void
  /** The cards of a column, with the drop line while dragging. */
  readonly list: (status: Column) => ComponentChildren
  /** Points the capture at Backlog or Todo. */
  readonly addTo: (status: 'backlog' | 'todo') => void
  /** The column under a drag, if any: its rail lights up. */
  readonly dropOn: Column | undefined
  readonly rootRef: RefObject<HTMLDivElement>
}) {
  const counts = {
    backlog: columns.backlog.length,
    todo: columns.todo.length,
    in_progress: columns.in_progress.length,
    blocked: columns.blocked.length,
    done: columns.done.length,
    canceled: columns.canceled.length,
  }
  // A pinned column opens at the far end of the strip: bring it into view, or the click seems to do nothing.
  const strip = useRef<HTMLDivElement>(null)
  const before = useRef(opened)
  useEffect(() => {
    const added = PINNED.some((status) => opened.has(status) && !before.current.has(status))
    before.current = opened
    if (added) strip.current?.scrollTo({ left: strip.current.scrollWidth, behavior: 'smooth' })
  }, [opened])

  return (
    <div class="t-board" ref={rootRef}>
      <div class="t-scroll" data-scroll ref={strip}>
        {boardLayout(counts, opened).map(({ status, shape }) =>
          shape === 'rail' ? (
            <section key={status} class={dropOn === status ? 't-rail t-rail-target' : 't-rail'} data-column={status} aria-label={`${labelOf(status)}, empty`}>
              <StatusGlyph status={status} />
              <span class="t-rail-label">{labelOf(status)}</span>
              <span class="num dim-3">0</span>
            </section>
          ) : (
            <section key={status} class="t-column" data-column={status} aria-label={labelOf(status)}>
              <header class="t-col-head">
                <StatusGlyph status={status} />
                <h2>{labelOf(status)}</h2>
                <span class="num dim-3">{counts[status]}</span>
                {status === 'backlog' || status === 'todo' ? (
                  <button type="button" class="t-col-add" aria-label={`Add to ${labelOf(status)}`} onClick={() => addTo(status)}>
                    <Icon name="plus" size={14} />
                  </button>
                ) : null}
              </header>
              {list(status)}
            </section>
          ),
        )}
      </div>
      <div class="t-pins">
        {PINNED.map((status) => {
          const classes = ['t-pin', counts[status] === 0 ? 't-pin-empty' : '', dropOn === status ? 't-rail-target' : '']
          return (
            <button
              key={status}
              type="button"
              class={classes.filter((c) => c !== '').join(' ')}
              data-column={status}
              aria-expanded={opened.has(status)}
              aria-label={`${labelOf(status)}, ${counts[status]}`}
              onClick={() => toggle(status)}
            >
              <StatusGlyph status={status} />
              <span class="t-rail-label">{labelOf(status)}</span>
              <span class="num">{counts[status]}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
