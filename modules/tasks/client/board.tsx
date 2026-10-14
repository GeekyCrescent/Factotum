/**
 * The board (design D11): the cycle on top, the filters, and the columns.
 *
 * DESKTOP (≥ 900 px): six columns side by side, scrolling sideways when they do not fit; a card is
 * dragged by its grip to another column and place (criterion 7). Backlog and Todo carry the quick
 * capture at their foot.
 *
 * PHONE: tabs with the count of each column, one column at a time, and the quick capture fixed at the
 * bottom. No dragging: a card opens as a sheet, and «Move to…» is in it.
 *
 * «CLOSE W42» opens by itself while a close is pending (criterion 15). «Later» hides it for this
 * visit only, and leaves a notice: it comes back next time the board opens (criterion 17).
 */

import { useCallback, useRef, useState } from 'preact/hooks'
import type { BoardView } from '../types.ts'
import { Card } from './card.tsx'
import { QuickCapture } from './capture.tsx'
import { CloseCycle } from './close-cycle.tsx'
import type { ViewProps } from './contract.ts'
import { useBoardDrag } from './drag.ts'
import {
  COLUMNS,
  columnsOf,
  cycleTitle,
  labelOf,
  matches,
  neighbours,
  parseFilter,
  projectKey,
  serializeFilter,
  todayIn,
  type Column,
  type Filter,
} from './model.ts'
import { TaskSheet } from './task-sheet.tsx'
import { useBoard, useWide } from './use-board.ts'

/** On this device only (criterion 13). */
const FILTER_KEY = 'factotum.tasks.filter'

function readFilter(): Filter {
  try {
    return parseFilter(localStorage.getItem(FILTER_KEY))
  } catch {
    return {}
  }
}

function writeFilter(filter: Filter): void {
  try {
    localStorage.setItem(FILTER_KEY, serializeFilter(filter))
  } catch {
    // Private mode or a full disk: the filter still applies, it just will not survive a reload.
  }
}

export function Board({ props, openTask }: { readonly props: ViewProps; readonly openTask: string | undefined }) {
  const { api, navigate } = props
  const board = useBoard(api)
  const wide = useWide()
  const [filter, setFilterState] = useState<Filter>(readFilter)
  const [tab, setTab] = useState<Column>('todo')
  const [closeLater, setCloseLater] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  const setFilter = (next: Filter): void => {
    writeFilter(next)
    setFilterState(next)
  }

  const view = board.view
  const shown = view === undefined ? [] : view.tasks.filter((task) => matches(task, filter))
  const columns = columnsOf(shown)
  const today = view === undefined ? '' : todayIn(view.timeZone)

  const open = useCallback((id: string) => navigate(encodeURIComponent(id)), [navigate])
  const add = (title: string, status: 'backlog' | 'todo'): Promise<boolean> => board.act('tasks', { title, status })

  const { dragging, start } = useBoardDrag(root, (id, drop) => {
    const ids = columns[drop.status].filter((task) => task.id !== id).map((task) => task.id)
    void board.act(`tasks/${encodeURIComponent(id)}/move`, { status: drop.status, ...neighbours(ids, drop.index) })
  })

  if (view === undefined) {
    return board.error === undefined ? <div class="t-loading dim-3">Loading the board…</div> : <ErrorNotice message={board.error} />
  }

  const list = (status: Column, withGrip: boolean) => {
    const cards = columns[status]
    const drop = dragging?.drop?.status === status ? dragging.drop.index : undefined
    const others = cards.filter((task) => task.id !== dragging?.id)
    const items = cards.map((task) => (
      <Card
        key={task.id}
        task={task}
        today={today}
        open={open}
        dragged={task.id === dragging?.id}
        {...(withGrip ? { grip: start } : {})}
      />
    ))
    if (drop !== undefined) {
      const anchor = others[drop]
      const at = anchor === undefined ? items.length : cards.indexOf(anchor)
      items.splice(at, 0, <li key="drop" class="t-drop-line" aria-hidden="true" />)
    }
    return (
      <ul class="t-list" aria-label={labelOf(status)}>
        {items}
        {cards.length === 0 && drop === undefined ? <li class="t-empty dim-3">Nothing here</li> : null}
      </ul>
    )
  }

  const closing = view.needsClose && !closeLater && openTask === undefined

  return (
    <div class="t-screen">
      <header class="t-head">
        <div class="t-head-text">
          <h2 class="t-cycle">{cycleTitle(view.openCycle, view.openRange)}</h2>
          <p class="dim-3 t-zone">{view.timeZone}</p>
        </div>
        <div class="t-head-acts">
          <span class="chip num" title="What the AI creates lands here (second cut)">
            Triage ({view.triage})
          </span>
          <button type="button" class="btn sm quiet" onClick={() => navigate('cycles')}>
            Cycles
          </button>
        </div>
      </header>

      {view.needsClose && closeLater ? (
        <div class="notice ask" role="status">
          <div class="head">{view.openCycle.slice(5)} is still open</div>
          <p>Close it to start {view.currentCycle.slice(5)}. Cards added now go to {view.openCycle.slice(5)}.</p>
          <div class="acts">
            <button type="button" class="btn sm" onClick={() => setCloseLater(false)}>
              Close {view.openCycle.slice(5)}
            </button>
          </div>
        </div>
      ) : null}

      {board.error === undefined ? null : <ErrorNotice message={board.error} onDismiss={board.clearError} />}

      <Filters view={view} filter={filter} setFilter={setFilter} />

      {wide ? (
        <div class="t-columns" ref={root}>
          {COLUMNS.map((column) => (
            <section key={column.status} class="t-column" data-column={column.status} aria-label={column.label}>
              <header class="t-col-head">
                <span>{column.label}</span>
                <span class="num dim-3">{columns[column.status].length}</span>
              </header>
              {list(column.status, true)}
              {column.status === 'backlog' || column.status === 'todo' ? (
                <QuickCapture target={column.status} label={column.label} add={add} />
              ) : null}
            </section>
          ))}
        </div>
      ) : (
        <>
          <div class="t-tabs" role="tablist" aria-label="Columns">
            {COLUMNS.map((column) => (
              <button
                key={column.status}
                type="button"
                role="tab"
                aria-selected={tab === column.status}
                class={tab === column.status ? 't-tab t-tab-on' : 't-tab'}
                onClick={() => setTab(column.status)}
              >
                {column.label} <span class="num">{columns[column.status].length}</span>
              </button>
            ))}
          </div>
          <div class="t-phone-column" role="tabpanel">
            {list(tab, false)}
          </div>
          <QuickCapture
            sticky
            target={tab === 'backlog' ? 'backlog' : 'todo'}
            label={tab === 'backlog' ? 'Backlog' : 'Todo'}
            add={add}
          />
        </>
      )}

      {openTask === undefined ? null : (
        <TaskSheet key={openTask} api={api} id={openTask} view={view} act={board.act} error={board.error} onClose={() => navigate('')} />
      )}
      {closing ? <CloseCycle view={view} act={board.act} onLater={() => setCloseLater(true)} /> : null}
    </div>
  )
}

function Filters({ view, filter, setFilter }: { readonly view: BoardView; readonly filter: Filter; readonly setFilter: (next: Filter) => void }) {
  const set = (key: keyof Filter, value: string): void => {
    const { [key]: _dropped, ...rest } = filter
    setFilter(value === '' ? rest : { ...rest, [key]: value })
  }
  const active = filter.area !== undefined || filter.label !== undefined || filter.project !== undefined
  // A filter on something no card uses any more still shows, so it can be cleared.
  const with_ = (values: readonly string[], current: string | undefined): readonly string[] =>
    current === undefined || values.includes(current) ? values : [...values, current]
  return (
    <div class="t-filters">
      <select aria-label="Area" value={filter.area ?? ''} onChange={(e) => set('area', (e.target as HTMLSelectElement).value)}>
        <option value="">All areas</option>
        {with_(view.areas, filter.area).map((area) => (
          <option key={area} value={area}>
            {area}
          </option>
        ))}
      </select>
      <select aria-label="Label" value={filter.label ?? ''} onChange={(e) => set('label', (e.target as HTMLSelectElement).value)}>
        <option value="">All labels</option>
        {with_(view.labels, filter.label).map((label) => (
          <option key={label} value={label}>
            {label}
          </option>
        ))}
      </select>
      <select aria-label="Project" value={filter.project ?? ''} onChange={(e) => set('project', (e.target as HTMLSelectElement).value)}>
        <option value="">All projects</option>
        {with_(view.projects.map(projectKey), filter.project).map((key) => (
          <option key={key} value={key}>
            {key.startsWith('/') ? key.slice(1) : key.replace('/', ' · ')}
          </option>
        ))}
      </select>
      {active ? (
        <button type="button" class="btn sm quiet" onClick={() => setFilter({})}>
          Clear
        </button>
      ) : null}
    </div>
  )
}

export function ErrorNotice({ message, onDismiss }: { readonly message: string; readonly onDismiss?: () => void }) {
  return (
    <div class="notice err" role="alert">
      <div class="head">Something went wrong</div>
      <p>{message}</p>
      {onDismiss === undefined ? null : (
        <div class="acts">
          <button type="button" class="btn sm" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}

