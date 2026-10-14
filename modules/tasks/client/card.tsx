/**
 * A card in its column (design D11): title, area, priority, due date (red when overdue, criterion 11),
 * «3/5» of subtasks (criterion 12) and the colour of its project. A tap opens it; on the desktop the
 * grip drags it.
 */

import type { Task } from '../types.ts'
import { Icon } from './icon.tsx'
import { isOverdue, PRIORITIES, progressOf, shortDay } from './model.ts'

/** A project keeps one of the six project hues, chosen by its name so it is the same on every screen. */
function hueOf(siteId: string): number {
  let sum = 0
  for (const char of siteId) sum = (sum * 31 + char.charCodeAt(0)) % 9973
  return (sum % 6) + 1
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
  const progress = progressOf(task)
  const priority = task.priority === 0 ? undefined : PRIORITIES.find((p) => p.value === task.priority)?.label
  const hue = task.project === null ? undefined : hueOf(task.project.siteId)
  return (
    <li class={dragged ? 't-card t-dragged' : 't-card'} data-card={task.id} data-status={task.status}>
      {hue === undefined ? null : <span class={`t-hue t-hue-${hue}`} aria-hidden="true" />}
      <button type="button" class="t-card-open" onClick={() => open(task.id)}>
        <span class="t-card-title">{task.title}</span>
        <span class="t-card-meta">
          {priority === undefined ? null : <span class={`t-prio t-prio-${task.priority}`}>{priority}</span>}
          {task.area === null ? null : <span class="t-area">{task.area}</span>}
          {task.due === null ? null : (
            <span class={overdue ? 't-due t-overdue' : 't-due'}>
              {overdue ? 'Overdue · ' : ''}
              {shortDay(task.due)}
            </span>
          )}
          {progress === undefined ? null : <span class="num">{progress}</span>}
          {task.estimate === null ? null : <span class="t-estimate num">{task.estimate}</span>}
          {task.project === null ? null : <span class="dim-3">{task.project.siteId}</span>}
        </span>
      </button>
      {grip === undefined ? null : (
        // Out of the tab order: a keyboard moves a card with «Move to…» in its sheet (WCAG 2.5.7).
        <button
          type="button"
          class="icon-btn t-grip"
          aria-label={`Drag ${task.title}`}
          tabIndex={-1}
          onPointerDown={(event) => grip(task.id, event)}
        >
          <Icon name="dots-six-vertical" size={16} />
        </button>
      )}
    </li>
  )
}
