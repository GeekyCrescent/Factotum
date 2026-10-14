/**
 * «Close W42» (criteria 15–17): every card in Todo, In progress or Blocked, «Next cycle» by default and
 * «Back to Backlog» on request; Done and Canceled as a summary. Nothing changes until Confirm.
 *
 * Confirming closes EVERY cycle from the open one up to the current one in one step (criterion 16):
 * the sheet names both when weeks were skipped.
 */

import { useState } from 'preact/hooks'
import type { BoardView } from '../types.ts'
import { closeMoves } from './model.ts'
import { Sheet } from './sheet.tsx'

export function CloseCycle({
  view,
  act,
  error,
  onLater,
}: {
  readonly view: BoardView
  readonly act: (path: string, body?: unknown) => Promise<boolean>
  /** Shown here: the board's notice is behind the scrim. */
  readonly error: string | undefined
  readonly onLater: () => void
}) {
  const [back, setBack] = useState<ReadonlySet<string>>(new Set())
  const [sending, setSending] = useState(false)
  const inCycle = view.tasks.filter((task) => task.cycle === view.openCycle)
  const unfinished = inCycle.filter((task) => task.status === 'todo' || task.status === 'in_progress' || task.status === 'blocked')
  const done = inCycle.filter((task) => task.status === 'done')
  const canceled = inCycle.filter((task) => task.status === 'canceled')
  const from = view.openCycle.slice(5)
  const to = view.currentCycle.slice(5)

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

  return (
    <Sheet id="t-close-title" title={`Close ${from}`} onClose={onLater}>
      {error === undefined ? null : (
        <div class="notice err" role="alert">
          <p>{error}</p>
        </div>
      )}
      <p class="dim-2">
        {view.currentCycle === view.openCycle ? null : `A new week has started: ${to}. `}
        Unfinished cards move on to {to} as they are, unless you send them back.
      </p>

      {unfinished.length === 0 ? (
        <p class="dim-3">Nothing unfinished.</p>
      ) : (
        <ul class="t-close-list">
          {unfinished.map((task) => {
            const toBacklog = back.has(task.id)
            return (
              <li key={task.id} class="t-close-row">
                <span class="t-close-title">{task.title}</span>
                <div class="t-segment" role="group" aria-label={`Where ${task.title} goes`}>
                  <button type="button" aria-pressed={!toBacklog} class={toBacklog ? '' : 't-seg-on'} onClick={() => choose(task.id, false)}>
                    Next cycle
                  </button>
                  <button type="button" aria-pressed={toBacklog} class={toBacklog ? 't-seg-on' : ''} onClick={() => choose(task.id, true)}>
                    Back to Backlog
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <p class="t-close-summary num">
        {done.length} done · {canceled.length} canceled — kept in the history of {from}.
      </p>

      <div class="t-acts">
        <button type="button" class="btn primary" disabled={sending} onClick={() => void confirm()}>
          {sending ? 'Closing…' : `Close ${from}`}
        </button>
        <button type="button" class="btn quiet" onClick={onLater}>
          Later
        </button>
      </div>
    </Sheet>
  )
}
