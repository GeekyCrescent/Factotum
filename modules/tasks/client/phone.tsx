/**
 * The board's pieces that only the phone has (redesign A): the strip that says what is overdue, and
 * the tabs — one per column, with its count — whose end is never cut without saying so: while there
 * are more tabs to the right, a «›» at the edge scrolls to them.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { Task } from '../types.ts'
import { Icon } from './icon.tsx'
import { COLUMNS, type Column } from './model.ts'

/** «2 overdue · Essay draft for 8780 · Open»: opens the oldest. Nothing when nothing is late. */
export function OverdueStrip({ late, open }: { readonly late: readonly Task[]; readonly open: (id: string) => void }) {
  const oldest = late[0]
  if (oldest === undefined) return null
  return (
    <button type="button" class="t-strip" onClick={() => open(oldest.id)}>
      <Icon name="warning" size={16} />
      <b>{late.length} overdue</b>
      <span class="t-strip-title">{oldest.title}</span>
      <span class="t-strip-go">
        Open
        <Icon name="caret-right" size={14} />
      </span>
    </button>
  )
}

/** Slack under which the strip counts as scrolled to its end: sub-pixel widths never meet exactly. */
const END_SLACK_PX = 2

export function Tabs({
  tab,
  setTab,
  counts,
}: {
  readonly tab: Column
  readonly setTab: (column: Column) => void
  readonly counts: Readonly<Record<Column, number>>
}) {
  const strip = useRef<HTMLDivElement>(null)
  const next = useRef<HTMLButtonElement>(null)
  const [more, setMore] = useState(false)

  const measure = useCallback((): void => {
    const element = strip.current
    if (element === null) return
    const now = element.scrollLeft + element.clientWidth < element.scrollWidth - END_SLACK_PX
    // The «›» is about to go while it holds the focus: hand it to the last tab, not to the page.
    if (!now && document.activeElement === next.current) element.querySelector<HTMLElement>('.t-tab:last-child')?.focus()
    setMore(now)
  }, [])

  // The strip's width changes with the window, a rotation, the font arriving, or a count gaining a digit.
  useEffect(() => {
    const element = strip.current
    if (element === null) return
    measure()
    // The strip AND its tabs: a tab growing (the font, a digit) changes the overflow, not the strip's box.
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const tabElement of element.children) observer.observe(tabElement)
    return () => observer.disconnect()
  }, [measure])
  useEffect(measure, [counts, measure])

  // The chosen tab is always in view, even when it was chosen from elsewhere (the overdue strip).
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [tab])

  return (
    <div class="t-tabs-wrap">
      <div class={more ? 't-tabs t-tabs-more' : 't-tabs'} role="group" aria-label="Columns" ref={strip} onScroll={measure}>
        {COLUMNS.map((column) => (
          <button
            key={column.status}
            type="button"
            aria-pressed={tab === column.status}
            class={['t-tab', tab === column.status ? 't-tab-on' : '', counts[column.status] === 0 ? 't-tab-empty' : ''].filter((c) => c !== '').join(' ')}
            onClick={() => setTab(column.status)}
          >
            {column.label} <span class="num">{counts[column.status]}</span>
          </button>
        ))}
      </div>
      {more ? (
        <button
          ref={next}
          type="button"
          class="icon-btn t-tabs-next"
          aria-label="More columns"
          onClick={() => strip.current?.scrollBy({ left: strip.current.clientWidth * 0.6, behavior: 'smooth' })}
        >
          <Icon name="caret-right" size={16} />
        </button>
      ) : null}
    </div>
  )
}
