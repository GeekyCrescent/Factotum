/**
 * The history of cycles (criterion 18): each closed cycle with what was done, canceled and carried on;
 * one opens to its cards. Read-only — a closed cycle keeps copies.
 */

import { useEffect, useState } from 'preact/hooks'
import type { ClosedCycle, CycleSummary, Task } from '../types.ts'
import { PageBar } from './bar.tsx'
import { ErrorNotice } from './board.tsx'
import type { ViewProps } from './contract.ts'
import { cycleTitle, messageOf, statusOf } from './model.ts'

export function Cycles({ props }: { readonly props: ViewProps }) {
  const { api, navigate, openDrawer, pendingTotal } = props
  const [cycles, setCycles] = useState<readonly CycleSummary[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    api
      .get<{ cycles: readonly CycleSummary[] }>('cycles')
      .then((body) => setCycles(body.cycles))
      .catch((cause: unknown) => setError(messageOf(cause)))
  }, [api])

  return (
    <>
      <PageBar title="Cycles" back={{ label: 'Board', go: () => navigate('') }} pendingTotal={pendingTotal} onMenu={openDrawer} />
      <div class="t-screen t-narrow t-pad">
        {error === undefined ? null : <ErrorNotice message={error} />}
        {cycles === undefined ? null : cycles.length === 0 ? (
          <div class="center-state">
            <h2>No closed cycles yet</h2>
            <p>A cycle closes on Monday, when you open the board in the new week.</p>
          </div>
        ) : (
          <ul class="t-cycles">
            {cycles.map((cycle) => (
              <li key={cycle.id}>
                <button type="button" class="t-cycle-row" onClick={() => navigate(`cycles/${cycle.id}`)}>
                  <span>{cycleTitle(cycle.id, cycle.range)}</span>
                  <span class="dim-2 num">
                    {cycle.done} done · {cycle.canceled} canceled · {cycle.carried} carried
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

export function CycleDetail({ props, id }: { readonly props: ViewProps; readonly id: string }) {
  const { api, navigate, openDrawer, pendingTotal } = props
  const [cycle, setCycle] = useState<ClosedCycle | null | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    api
      .get<ClosedCycle>(`cycles/${encodeURIComponent(id)}`)
      .then(setCycle)
      .catch((cause: unknown) => (statusOf(cause) === 404 || statusOf(cause) === 400 ? setCycle(null) : setError(messageOf(cause))))
  }, [api, id])

  const rows = (tasks: readonly Task[]) => (
    <ul class="t-list">
      {tasks.map((task) => (
        <li key={task.id} class="t-card">
          <button type="button" class="t-card-open" onClick={() => navigate(encodeURIComponent(task.id))}>
            <span class="t-card-title">{task.title}</span>
            {task.area === null ? null : <span class="t-card-meta"><span>{task.area}</span></span>}
          </button>
        </li>
      ))}
    </ul>
  )

  return (
    <>
      <PageBar title={id.slice(5)} back={{ label: 'Cycles', go: () => navigate('cycles') }} pendingTotal={pendingTotal} onMenu={openDrawer} />
      <div class="t-screen t-narrow t-pad">
        {error === undefined ? null : <ErrorNotice message={error} />}
        {cycle === null ? <p class="dim-2">That cycle is not in the history.</p> : null}
        {cycle ? (
          <>
            <h3 class="t-section-head">
              <span>Done</span>
              <span class="num dim-3">{cycle.done.length}</span>
            </h3>
            {rows(cycle.done)}
            <h3 class="t-section-head">
              <span>Canceled</span>
              <span class="num dim-3">{cycle.canceled.length}</span>
            </h3>
            {rows(cycle.canceled)}
            <p class="dim-3 num">{cycle.carried.length} carried on to the next cycle.</p>
          </>
        ) : null}
      </div>
    </>
  )
}
