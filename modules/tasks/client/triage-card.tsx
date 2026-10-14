/**
 * A card in Triage (redesign of Triage, direction A): THE BOARD'S CARD, with one row of decision under
 * it — «Todo | Backlog» and a quiet × to discard. Tapping the card opens it to edit, as on the board,
 * so there is no pencil. Where it came from (captured, an agent) is one small line above the title, and
 * «You wrote …» shows the owner's own words once Claude rewrote the title.
 *
 * The same card serves the phone's Triage screen and the Triage column of the board on a wide screen;
 * the column is tinted amber because it waits on the owner (colour as a signal, PRODUCT.md).
 */

import type { ComponentChildren, RefObject } from 'preact'
import type { Task } from '../types.ts'
import { ProjectTag } from './card.tsx'
import { PriorityGlyph } from './glyphs.tsx'
import { Icon } from './icon.tsx'
import { isOverdue, shortDay } from './model.ts'
import { agoOf, readingOf, sourceOf, wroteOf } from './triage-model.ts'
import type { Decision } from './use-triage.ts'

export function TriageCard({
  task,
  today,
  now,
  busy,
  open,
  decide,
}: {
  readonly task: Task
  readonly today: string
  readonly now: Date
  readonly busy: boolean
  readonly open: () => void
  readonly decide: (what: Decision) => void
}) {
  const source = sourceOf(task)
  const reading = readingOf(task)
  const wrote = wroteOf(task)
  const overdue = isOverdue(task, today)
  const classes = ['t-card', 't-tcard', reading === 'reading' ? 't-tcard-reading' : ''].filter((c) => c !== '').join(' ')
  return (
    <li class={classes} data-card={task.id}>
      <button type="button" class="t-card-open t-tcard-open" onClick={open} aria-label={`${task.title}. Open to edit`}>
        <span class="t-tsrc">
          <Icon name={source.kind === 'agent' ? 'terminal-window' : 'sparkle'} size={13} />
          {source.label} · {agoOf(task.createdAt, now)}
        </span>
        <span class="t-card-title">{task.title}</span>
        <span class="t-card-meta">
          {task.priority === 0 ? null : <PriorityGlyph priority={task.priority} labelled />}
          {task.due === null ? null : (
            <span class={overdue ? 't-overdue' : undefined}>
              <Icon name={overdue ? 'warning' : 'calendar-blank'} size={13} />
              {shortDay(task.due)}
            </span>
          )}
          {task.project === null ? null : <ProjectTag siteId={task.project.siteId} />}
          {task.area === null ? null : <span>{task.area}</span>}
          {reading === 'reading' ? (
            <span class="t-treading">
              <Icon name="circle-notch" size={13} class="t-spin" />
              Reading it…
            </span>
          ) : null}
          {reading === 'failed' ? <span class="t-tfailed">Couldn’t read it, the text is kept</span> : null}
        </span>
        {wrote === undefined ? null : <span class="t-twrote">«{wrote}»</span>}
      </button>
      <div class="t-tacts">
        {/* aria-disabled, not disabled: a disabled button drops the focus it holds (decide() guards a double tap). */}
        <div class="t-tseg" role="group" aria-label={`Accept ${task.title} to`}>
          <button type="button" data-triage-first aria-disabled={busy} onClick={() => decide('todo')}>
            Todo
          </button>
          <button type="button" aria-disabled={busy} onClick={() => decide('backlog')}>
            Backlog
          </button>
        </div>
        <button type="button" class="icon-btn t-tdiscard" aria-label={`Discard ${task.title}`} aria-disabled={busy} onClick={() => decide('discard')}>
          <Icon name="x" size={16} />
        </button>
      </div>
    </li>
  )
}

/** The cards of Triage as a list: the phone's screen and the board's column share it. */
export function TriageCards({
  tasks,
  today,
  busy,
  listRef,
  open,
  decide,
}: {
  readonly tasks: readonly Task[]
  readonly today: string
  readonly busy: ReadonlySet<string>
  readonly listRef: RefObject<HTMLUListElement>
  readonly open: (id: string) => void
  readonly decide: (id: string, index: number, what: Decision) => void
}) {
  const now = new Date()
  return (
    <ul class="t-list t-tlist" aria-label="Cards in Triage" ref={listRef}>
      {tasks.map((task, index) => (
        <TriageCard
          key={task.id}
          task={task}
          today={today}
          now={now}
          busy={busy.has(task.id)}
          open={() => open(task.id)}
          decide={(what) => decide(task.id, index, what)}
        />
      ))}
    </ul>
  )
}

/** Triage as the first column of the board on a wide screen: amber, because it waits on the owner. */
export function TriageColumn({ count, children }: { readonly count: number; readonly children: ComponentChildren }) {
  return (
    <section class="t-column t-tcol" aria-label={`Triage, ${count} to sort`}>
      <header class="t-col-head t-tcol-head">
        <Icon name="tray" size={16} />
        <h2>Triage</h2>
        <span class="num">{count}</span>
      </header>
      {children}
    </section>
  )
}
