/**
 * The board (design D11, redesign A). The module draws its own bar (`ownsTopBar`): the cycle and how
 * the week is going — days left, how much is done, and what is overdue — are the first line of the
 * screen, not a heading under the shell's «Tasks».
 *
 * DESKTOP (≥ 900 px): a toolbar with the capture (`N` focuses it) and the filters, then the board of
 * `desktop.tsx`. A card is dragged by its grip to another column and place (criterion 7), Done and
 * Canceled rails included.
 *
 * PHONE: the overdue strip, tabs with the count of each column, one column at a time, and the capture
 * fixed at the bottom. No dragging: a card opens as a sheet, and «Move to…» is in it. The filters are a
 * sheet behind the funnel in the bar.
 *
 * «CLOSE W42» opens by itself while a close is pending (criterion 15). «Later» hides it for this visit
 * only, and leaves a notice: it comes back next time the board opens (criterion 17).
 */

import type { ComponentChildren } from 'preact'
import { useCallback, useRef, useState } from 'preact/hooks'
import { TopBar } from './bar.tsx'
import { Card } from './card.tsx'
import { QuickCapture, useCaptureKey, type Target } from './capture.tsx'
import { CloseCycle } from './close-cycle.tsx'
import type { ViewProps } from './contract.ts'
import { DesktopBoard } from './desktop.tsx'
import { NextSheet } from './next.tsx'
import { useBoardDrag } from './drag.ts'
import { FilterMenus, FilterSheet } from './filters.tsx'
import { Icon } from './icon.tsx'
import {
  columnsOf,
  cycleTitle,
  filterCount,
  isSamePlace,
  labelOf,
  matches,
  neighbours,
  overdueOf,
  parseFilter,
  serializeFilter,
  todayIn,
  weekLine,
  weekOf,
  type Column,
  type Filter,
  type Pinned,
} from './model.ts'
import { OverdueStrip, Tabs } from './phone.tsx'
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

export function Board({
  props,
  openTask,
  asking = false,
}: {
  readonly props: ViewProps
  readonly openTask: string | undefined
  /** `/m/tasks/next`: «What's next?» open over the board. */
  readonly asking?: boolean
}) {
  const { api, navigate, openDrawer, pendingTotal } = props
  const board = useBoard(api)
  const wide = useWide()
  const [filter, setFilterState] = useState<Filter>(readFilter)
  const [tab, setTab] = useState<Column>('todo')
  const [closeLater, setCloseLater] = useState(false)
  const [filtering, setFiltering] = useState(false)
  const [opened, setOpened] = useState<ReadonlySet<Pinned>>(new Set())
  const [target, setTarget] = useState<Target>('todo')
  // A column's «+» points the capture at that column: until the field is left, Enter adds there by hand.
  const [pointed, setPointed] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const captureInput = useRef<HTMLInputElement>(null)
  useCaptureKey(captureInput, wide && board.view !== undefined)

  const setFilter = (next: Filter): void => {
    writeFilter(next)
    setFilterState(next)
  }

  const view = board.view
  const shown = view === undefined ? [] : view.tasks.filter((task) => matches(task, filter))
  const columns = columnsOf(shown)
  const today = view === undefined ? '' : todayIn(view.timeZone)

  const open = useCallback((id: string) => navigate(encodeURIComponent(id)), [navigate])
  const add = (title: string, status: Target): Promise<boolean> => board.act('tasks', { title, status })
  // To Triage, read by claude (criterion 21). The projects for the closed list arrive with the edge to sessions (G1).
  const capture = (text: string): Promise<boolean> => board.act('capture', { text })
  const toggle = (status: Pinned): void =>
    setOpened((was) => {
      const next = new Set(was)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  const addTo = (status: Target): void => {
    setTarget(status)
    setPointed(true)
    captureInput.current?.focus()
  }

  const { dragging, start } = useBoardDrag(root, (id, drop) => {
    const card = shown.find((task) => task.id === id)
    if (card === undefined || card.status === 'triage') return
    if (isSamePlace(columns[card.status].map((task) => task.id), id, card.status, drop)) return
    const ids = columns[drop.status].filter((task) => task.id !== id).map((task) => task.id)
    void board.act(`tasks/${encodeURIComponent(id)}/move`, { status: drop.status, ...neighbours(ids, drop.index) })
  })

  const bar = (children: ComponentChildren) => (
    <TopBar pendingTotal={pendingTotal} onMenu={openDrawer}>
      {children}
    </TopBar>
  )

  if (view === undefined) {
    return (
      <>
        {bar(
          <div class="title">
            <h1>Tasks</h1>
          </div>,
        )}
        <div class="t-screen t-pad">
          {board.error === undefined ? (
            <div class="t-loading dim-3" role="status">
              Loading the board…
            </div>
          ) : (
            <ErrorNotice
              message={board.error}
              action={{
                label: 'Try again',
                run: () => {
                  board.clearError()
                  void board.reload()
                },
              }}
            />
          )}
        </div>
      </>
    )
  }

  const list = (status: Column, withGrip: boolean) => {
    const cards = columns[status]
    const drop = dragging?.drop?.status === status ? dragging.drop.index : undefined
    const others = cards.filter((task) => task.id !== dragging?.id)
    const items = cards.map((task) => (
      <Card key={task.id} task={task} today={today} open={open} dragged={task.id === dragging?.id} {...(withGrip ? { grip: start } : {})} />
    ))
    if (drop !== undefined) {
      const anchor = others[drop]
      const at = anchor === undefined ? items.length : cards.indexOf(anchor)
      items.splice(at, 0, <li key="drop" class="t-drop-line" aria-hidden="true" />)
    }
    return (
      <ul class="t-list" aria-label={labelOf(status)}>
        {items}
        {cards.length === 0 && drop === undefined ? <li class="t-empty dim-2">No cards in {labelOf(status)}.</li> : null}
      </ul>
    )
  }

  const closing = view.needsClose && !closeLater && openTask === undefined && !asking
  const late = overdueOf(view.tasks, today)
  const week = weekLine(weekOf(view.tasks, view.openCycle, view.openRange, today))
  const counts: Record<Column, number> = {
    backlog: columns.backlog.length,
    todo: columns.todo.length,
    in_progress: columns.in_progress.length,
    blocked: columns.blocked.length,
    done: columns.done.length,
    canceled: columns.canceled.length,
  }
  const phoneTarget: Target = tab === 'backlog' ? 'backlog' : 'todo'
  const filters = filterCount(filter)

  return (
    <div class="t-screen">
      {bar(
        <>
          <h1 class="sr-only">Tasks</h1>
          <button type="button" class="t-cycle" aria-label={`${cycleTitle(view.openCycle, view.openRange)}, ${week}. Past cycles`} onClick={() => navigate('cycles')}>
            <span class="t-cycle-name">
              {cycleTitle(view.openCycle, view.openRange)}
              <Icon name="caret-down" size={14} />
            </span>
            <span class="t-week num">{week}</span>
          </button>
          {wide && late.length > 0 ? (
            <button type="button" class="t-late" onClick={() => open(late[0]?.id ?? '')}>
              <Icon name="warning" size={14} />
              {late.length} overdue
            </button>
          ) : null}
          <span class="t-bar-gap" />
          {wide ? (
            <button type="button" class="btn sm quiet t-next-open" onClick={() => navigate('next')}>
              <Icon name="lightbulb" size={16} />
              What's next?
            </button>
          ) : (
            <button type="button" class="icon-btn" aria-label="What's next?" onClick={() => navigate('next')}>
              <Icon name="lightbulb" size={20} />
            </button>
          )}
          {view.triage > 0 ? (
            <button type="button" class="t-triage" onClick={() => navigate('triage')}>
              <Icon name="tray" size={wide ? 16 : 20} />
              <span class="sr-only">Triage, {view.triage} waiting</span>
              {wide ? <span aria-hidden="true">Triage</span> : null}
              <span class="count-ask num" aria-hidden="true">
                {view.triage}
              </span>
            </button>
          ) : null}
          {wide ? null : (
            <button type="button" class="icon-btn" aria-label={filters > 0 ? `Filter, ${filters} on` : 'Filter'} onClick={() => setFiltering(true)}>
              <Icon name="funnel" size={20} />
              {/* A dot in the accent, not the shell's amber badge: a filter is on, nothing waits for you. */}
              {filters > 0 ? <span class="t-filter-dot" aria-hidden="true" /> : null}
            </button>
          )}
        </>,
      )}

      {wide ? null : (
        <OverdueStrip
          late={late}
          open={(id) => {
            const card = late.find((task) => task.id === id)
            if (card !== undefined && card.status !== 'triage') setTab(card.status)
            open(id)
          }}
        />
      )}

      {view.needsClose && closeLater ? (
        <div class="notice ask t-pad-x" role="status">
          <div class="head">{view.openCycle.slice(5)} is still open</div>
          <p>Close it to start {view.currentCycle.slice(5)}. Cards added now go to {view.openCycle.slice(5)}.</p>
          <div class="acts">
            <button type="button" class="btn sm" onClick={() => setCloseLater(false)}>
              Close {view.openCycle.slice(5)}
            </button>
          </div>
        </div>
      ) : null}

      {board.error === undefined ? null : (
        <div class="t-pad-x">
          <ErrorNotice message={board.error} action={{ label: 'Dismiss', run: board.clearError }} />
        </div>
      )}

      {wide ? (
        <>
          <div class="t-toolbar">
            <QuickCapture
              target={target}
              label={labelOf(target)}
              add={add}
              {...(pointed ? {} : { capture })}
              input={captureInput}
              onLeave={() => setPointed(false)}
            />
            <FilterMenus view={view} filter={filter} setFilter={setFilter} />
          </div>
          <DesktopBoard
            columns={columns}
            opened={opened}
            toggle={toggle}
            list={(status) => list(status, true)}
            addTo={addTo}
            dropOn={dragging?.drop?.status}
            rootRef={root}
          />
        </>
      ) : (
        <>
          <Tabs tab={tab} setTab={setTab} counts={counts} />
          <div class="t-phone-column">{list(tab, false)}</div>
          <QuickCapture sticky target={phoneTarget} label={labelOf(phoneTarget)} add={add} capture={capture} />
        </>
      )}

      {filtering && !wide ? (
        <FilterSheet view={view} filter={filter} setFilter={setFilter} shown={shown.length} onClose={() => setFiltering(false)} />
      ) : null}
      {openTask === undefined ? null : (
        <TaskSheet key={openTask} api={api} id={openTask} view={view} today={today} act={board.act} error={board.error} onClose={() => navigate('')} />
      )}
      {asking ? <NextSheet api={api} view={view} today={today} open={open} onClose={() => navigate('')} /> : null}
      {closing ? <CloseCycle view={view} today={today} act={board.act} error={board.error} onLater={() => setCloseLater(true)} /> : null}
    </div>
  )
}

export function ErrorNotice({
  message,
  action,
}: {
  readonly message: string
  readonly action?: { readonly label: string; readonly run: () => void }
}) {
  return (
    <div class="notice err" role="alert">
      <div class="head">Something went wrong</div>
      <p>{message}</p>
      {action === undefined ? null : (
        <div class="acts">
          <button type="button" class="btn sm" onClick={action.run}>
            {action.label}
          </button>
        </div>
      )}
    </div>
  )
}
