/**
 * A card in its column (design D11, redesign A): the title in two lines at most, and ONE line of
 * signals under it — priority, due date (red when overdue, criterion 11), «3/5» of subtasks
 * (criterion 12), the project as a dot in its hue and the area. A tap opens it; on the desktop the
 * grip drags it.
 *
 * The project is a dot, never a coloured stripe down the side (direccion-visual, «Bordes»).
 */

import type { Task } from '../types.ts'
import { PriorityGlyph } from './glyphs.tsx'
import { Icon } from './icon.tsx'
import { isOverdue, progressOf, shortDay } from './model.ts'

/** A project keeps one of the six project hues, chosen by its name so it is the same on every screen. */
export function hueOf(siteId: string): number {
  let sum = 0
  for (const char of siteId) sum = (sum * 31 + char.charCodeAt(0)) % 9973
  return (sum % 6) + 1
}

/** The project as a dot in its hue and its name; `label` when the host is part of what is shown. */
export function ProjectTag({ siteId, label = siteId }: { readonly siteId: string; readonly label?: string }) {
  return <span class={`t-proj t-hue-${hueOf(siteId)}`}>{label}</span>
}

/** «3/5» with a ring that fills as the subtasks are ticked. */
function Progress({ task }: { readonly task: Task }) {
  const label = progressOf(task)
  if (label === undefined) return null
  const done = task.subtasks.filter((s) => s.done).length
  const length = 2 * Math.PI * 5
  return (
    <span class="num">
      <span class="sr-only">Subtasks done: </span>
      <svg class="t-ring" viewBox="0 0 14 14" width={13} height={13} aria-hidden="true" focusable="false">
        <circle cx="7" cy="7" r="5" />
        <circle class="t-ring-done" cx="7" cy="7" r="5" stroke-dasharray={`${(length * done) / task.subtasks.length} ${length}`} />
      </svg>
      {label}
    </span>
  )
}

export function Card({
  task,
  today,
  open,
  grip,
  dragged,
}: {
  readonly task: Task
  readonly today: string
  readonly open: (id: string) => void
  /** Only on the desktop: where a drag starts. */
  readonly grip?: (id: string, event: PointerEvent) => void
  readonly dragged: boolean
}) {
  const overdue = isOverdue(task, today)
  const finished = task.status === 'done' || task.status === 'canceled'
  const classes = ['t-card', dragged ? 't-dragged' : '', finished ? 't-finished' : '', grip === undefined ? '' : 't-has-grip']
  return (
    <li class={classes.filter((c) => c !== '').join(' ')} data-card={task.id} data-status={task.status}>
      <button type="button" class="t-card-open" onClick={() => open(task.id)}>
        <span class="t-card-title">{task.title}</span>
        <span class="t-card-meta">
          <PriorityGlyph priority={task.priority} labelled />
          {task.due === null ? null : (
            <span class={overdue ? 't-overdue' : undefined}>
              <Icon name={overdue ? 'warning' : 'calendar-blank'} size={13} />
              {overdue ? <span class="sr-only">Overdue, due </span> : null}
              {shortDay(task.due)}
            </span>
          )}
          <Progress task={task} />
          {task.project === null ? null : <ProjectTag siteId={task.project.siteId} />}
          {task.area === null ? null : <span>{task.area}</span>}
        </span>
      </button>
      {grip === undefined ? null : (
        // Out of the tab order: a keyboard moves a card with «Move to…» in its sheet (WCAG 2.5.7).
        <button
          type="button"
          class="t-grip"
          aria-label={`Drag ${task.title}`}
          tabIndex={-1}
          aria-hidden="true"
          onPointerDown={(event) => grip(task.id, event)}
        >
          <Icon name="dots-six-vertical" size={16} />
        </button>
      )}
    </li>
  )
}
