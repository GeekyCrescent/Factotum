/**
 * «Close W42» (criteria 15–17, redesign A): opens by itself once a new week has started. It says how the
 * week ended, then lists every unfinished card with where it goes — on to the new cycle as it is, or
 * back to Backlog. By default nothing is lost: every card goes on. «All to Backlog» flips every row at
 * once, and flips them back.
 *
 * Done and canceled cards are not listed: they stay in the history of the closed cycle.
 */

import { useState } from 'preact/hooks'
import type { BoardView, Task } from '../types.ts'
import { StatusGlyph } from './glyphs.tsx'
import { closeMoves, isOverdue, rangeLabel, shortDay } from './model.ts'
import { Sheet } from './sheet.tsx'

const UNFINISHED: readonly Task['status'][] = ['in_progress', 'todo', 'blocked']

export function CloseCycle({
  view,
  today,
  act,
  error,
  onLater,
}: {
  readonly view: BoardView
  readonly today: string
  readonly act: (path: string, body?: unknown) => Promise<boolean>
  /** Shown here: the board's notice is behind the scrim. */
  readonly error: string | undefined
  readonly onLater: () => void
}) {
  const [back, setBack] = useState<ReadonlySet<string>>(new Set())
  const [sending, setSending] = useState(false)
  const inCycle = view.tasks.filter((task) => task.cycle === view.openCycle)
  // In progress first: what was being worked on is the first thing to decide about.
  const unfinished = UNFINISHED.flatMap((status) => inCycle.filter((task) => task.status === status))
  const done = inCycle.filter((task) => task.status === 'done').length
  const canceled = inCycle.filter((task) => task.status === 'canceled').length
  const from = view.openCycle.slice(5)
  const to = view.currentCycle.slice(5)
  const allBack = unfinished.length > 0 && unfinished.every((task) => back.has(task.id))

  const choose = (id: string, toBacklog: boolean): void =>
    setBack((was) => {
      const next = new Set(was)
      if (toBacklog) next.add(id)
      else next.delete(id)
      return next
    })

  const confirm = async (): Promise<void> => {
    setSending(true)
    // A 409 (closed on another device) still reloads the board, which then has nothing to close.
    await act('cycles/close', { from: view.openCycle, moves: closeMoves(unfinished.map((t) => t.id), back) })
    setSending(false)
  }

  const foot = (
    <>
      <span class="t-changes">Done and canceled cards stay in the history of {from}.</span>
      <button type="button" class="btn quiet" onClick={onLater}>
        Later
      </button>
      <button type="button" class="btn primary" disabled={sending} onClick={() => void confirm()}>
        {sending ? 'Closing…' : `Close ${from}`}
      </button>
    </>
  )

  return (
    <Sheet id="t-close-title" title={`Close ${from}`} onClose={onLater} foot={foot} wide>
      <p class="dim-2 t-close-sub">
        {rangeLabel(view.openRange)} {view.currentCycle === view.openCycle ? 'ends this week.' : `is over; ${to} has started.`}
      </p>
      {error === undefined ? null : (
        <div class="notice err" role="alert">
          <p>{error}</p>
        </div>
      )}
      <p class="t-tally num">
        <span>
          <StatusGlyph status="done" />
          <b>{done}</b> done
        </span>
        <span>
          <StatusGlyph status="canceled" />
          <b>{canceled}</b> canceled
        </span>
        <span>
          <StatusGlyph status="todo" />
          <b>{unfinished.length}</b> unfinished
        </span>
      </p>

      {unfinished.length === 0 ? (
        <p class="dim-2">Nothing unfinished: the week closes clean.</p>
      ) : (
        <>
          <div class="t-close-lead">
            <p class="dim-2">Unfinished cards go on to {to} as they are, unless you send them back.</p>
            <button type="button" class="btn quiet" onClick={() => setBack(allBack ? new Set() : new Set(unfinished.map((t) => t.id)))}>
              {allBack ? `All to ${to}` : 'All to Backlog'}
            </button>
          </div>
          <ul class="t-close-list">
            {unfinished.map((task) => {
              const toBacklog = back.has(task.id)
              const late = isOverdue(task, today)
              return (
                <li key={task.id} class="t-close-row">
                  <StatusGlyph status={task.status === 'triage' ? 'todo' : task.status} />
                  <span class="t-close-text">
                    <span class="t-close-title">{task.title}</span>
                    {task.due === null ? null : <span class={late ? 't-overdue' : 'dim-2'}>Due {shortDay(task.due)}</span>}
                  </span>
                  <span class="t-segment" role="group" aria-label={`Where ${task.title} goes`}>
                    <button type="button" aria-pressed={!toBacklog} onClick={() => choose(task.id, false)}>
                      {to}
                    </button>
                    <button type="button" aria-pressed={toBacklog} onClick={() => choose(task.id, true)}>
                      Backlog
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Sheet>
  )
}
