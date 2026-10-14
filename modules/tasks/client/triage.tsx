/**
 * Triage, `/m/tasks/triage` (design D11; criteria 19–23c): what the AI created, waiting for the owner.
 * Nothing here is on the board until it is accepted — to Todo or to Backlog — and a card can be edited
 * first, in the same sheet as any card, or discarded without a question (S10).
 *
 * REDESIGN, DIRECTION A (maquetas/triage.html): the board's own cards, each with ONE row of decision.
 * On a wide screen the same cards are the first column of the board (`board.tsx`); this screen is the
 * phone's, and the one the Triage chip opens.
 *
 * EDITING IS A ROUTE, `triage/<id>`: the phone's Back closes the sheet instead of leaving Triage.
 */

import { useCallback } from 'preact/hooks'
import { PageBar } from './bar.tsx'
import { ErrorNotice } from './board.tsx'
import type { ViewProps } from './contract.ts'
import { useBoardEdge } from './edge.ts'
import { todayIn } from './model.ts'
import { TaskSheet } from './task-sheet.tsx'
import { TriageCards } from './triage-card.tsx'
import { useBoard } from './use-board.ts'
import { decidedLine, useDecide, useTriage } from './use-triage.ts'

export function Triage({ props, editing }: { readonly props: ViewProps; readonly editing: string | undefined }) {
  const { api, navigate, openDrawer, pendingTotal } = props
  const board = useBoard(api)
  const triage = useTriage(api)
  const { edge, hostProjects } = useBoardEdge(props)
  const { act: boardAct } = board
  const { reload: triageReload } = triage

  /** A change, then the list read again: what was accepted leaves it. */
  const act = useCallback(
    async (path: string, body?: unknown): Promise<boolean> => {
      const sent = await boardAct(path, body)
      await triageReload()
      return sent
    },
    [boardAct, triageReload],
  )
  const list = triage.list
  const { decide, busy, said, listRef, leadRef } = useDecide(act, list?.tasks)

  const back = { label: 'Board', go: () => navigate('') }
  const bar = <PageBar title="Triage" back={back} pendingTotal={pendingTotal} onMenu={openDrawer} />
  const view = board.view
  const today = view === undefined ? '' : todayIn(view.timeZone)
  const error = board.error ?? triage.error
  const dismiss = (): void => {
    board.clearError()
    triage.clearError()
  }

  if (list === undefined) {
    return (
      <div class="t-screen">
        {bar}
        <div class="t-pad">
          {triage.error === undefined ? (
            <div class="t-loading dim-3" role="status">
              Loading Triage…
            </div>
          ) : (
            <ErrorNotice message={triage.error} action={{ label: 'Try again', run: () => void triage.reload() }} />
          )}
        </div>
      </div>
    )
  }

  return (
    <div class="t-screen">
      {bar}
      <p class="t-tlead dim-2" ref={leadRef} tabIndex={-1}>
        {list.tasks.length === 0
          ? 'Nothing to sort. What the AI captures lands here first.'
          : `${list.tasks.length} to sort. Tap a card to edit it; nothing reaches the board until you accept it.`}
      </p>
      {/* One persistent region, so a screen reader hears what each decision did. */}
      <p class="sr-only" role="status">
        {decidedLine(said, list.tasks.length)}
      </p>
      {error === undefined ? null : (
        <div class="t-pad-x">
          <ErrorNotice message={error} action={{ label: 'Dismiss', run: dismiss }} />
        </div>
      )}
      <div class="t-tpage">
        <TriageCards
          tasks={list.tasks}
          today={today}
          busy={busy}
          listRef={listRef}
          // The sheet needs the board (its areas, its zone): opening waits for it.
          open={(id) => (view === undefined ? undefined : navigate(`triage/${encodeURIComponent(id)}`))}
          decide={(id, index, what) => void decide(id, index, what)}
        />
      </div>
      {editing === undefined || view === undefined ? null : (
        // The board's view with the cards of triage in it, so the sheet finds the card live and lets it be edited.
        <TaskSheet
          key={editing}
          api={api}
          id={editing}
          view={{ ...view, tasks: [...view.tasks, ...list.tasks] }}
          today={today}
          act={act}
          error={board.error}
          onClose={() => navigate('triage')}
          edge={edge}
          {...(hostProjects === undefined ? {} : { hostProjects })}
        />
      )}
    </div>
  )
}
