/**
 * The board's two drawn glyphs (redesign A): a circle per status, as Linear draws them, and three bars
 * for a priority. Not Phosphor: they carry a state, so they are drawn to be read at 16 px, and their
 * colour comes from the stylesheet (`.t-st-*`, `.t-prio`) — colour only where the state means
 * something: in progress in the accent, done in green.
 *
 * Decorative where a word sits next to them; a glyph alone carries its own label.
 */

import type { Task } from '../types.ts'
import { PRIORITIES, type Column } from './model.ts'

export function StatusGlyph({ status }: { readonly status: Column }) {
  return (
    <svg class={`t-st t-st-${status}`} viewBox="0 0 16 16" width={16} height={16} aria-hidden="true" focusable="false">
      {status === 'done' ? (
        <>
          <circle class="t-st-fill" cx="8" cy="8" r="7" />
          <path class="t-st-tick" d="M5.2 8.2l1.9 1.9 3.7-3.9" />
        </>
      ) : (
        <circle cx="8" cy="8" r="6.2" />
      )}
      {status === 'in_progress' ? <path class="t-st-fill" d="M8 4.2a3.8 3.8 0 0 1 0 7.6z" /> : null}
      {status === 'blocked' ? <path d="M5.2 8h5.6" /> : null}
      {status === 'canceled' ? <path d="M6 6l4 4M10 6l-4 4" /> : null}
    </svg>
  )
}

const BARS = [
  { x: 1.5, y: 9, h: 5 },
  { x: 6.5, y: 5.5, h: 8.5 },
  { x: 11.5, y: 2, h: 12 },
] as const

/** Three bars, as many lit as the priority is high; a filled square with «!» for Urgent. Nothing for none. */
export function PriorityGlyph({ priority, labelled = false }: { readonly priority: Task['priority']; readonly labelled?: boolean }) {
  if (priority === 0) return null
  const label = PRIORITIES.find((p) => p.value === priority)?.label ?? ''
  const a11y = labelled ? { role: 'img' as const, 'aria-label': `${label} priority` } : { 'aria-hidden': true }
  if (priority === 1) {
    return (
      <svg class="t-prio t-prio-urgent" viewBox="0 0 16 16" width={14} height={14} focusable="false" {...a11y}>
        <rect x="1" y="1" width="14" height="14" rx="3.5" />
        <path d="M8 4.5v4.2M8 11.3v.2" />
      </svg>
    )
  }
  const lit = { 2: 3, 3: 2, 4: 1 }[priority]
  return (
    <svg class="t-prio" viewBox="0 0 16 16" width={14} height={14} focusable="false" {...a11y}>
      {BARS.map((bar, i) => (
        <rect key={bar.x} class={i < lit ? 't-prio-on' : undefined} x={bar.x} y={bar.y} width="3" height={bar.h} rx="1" />
      ))}
    </svg>
  )
}
