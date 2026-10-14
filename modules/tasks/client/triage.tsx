/**
 * Triage, `/m/tasks/triage` (design D11; criteria 19–23c): what the AI created, waiting for the owner.
 * Nothing here is on the board until it is accepted — to Todo or to Backlog — and a card can be edited
 * first, in the same sheet as any card, or discarded without a question (S10).
 *
 * A CARD CLAUDE IS STILL READING says «Reading it…», and the list is read again every `POLL_MS` while
 * one is — and only while the screen is visible. When none is left, the polling stops (crit. 23c).
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { Task } from '../types.ts'
import { PageBar } from './bar.tsx'
import { ErrorNotice } from './board.tsx'
import { ProjectTag } from './card.tsx'
import type { ViewProps } from './contract.ts'
import { PriorityGlyph } from './glyphs.tsx'
import { Icon } from './icon.tsx'
import { messageOf, shortDay, todayIn } from './model.ts'
import { TaskSheet } from './task-sheet.tsx'
import { agoOf, anyReading, readingOf, sourceOf, wroteOf } from './triage-model.ts'
import { useBoard } from './use-board.ts'

/** As the inbox: often enough to see a card land, rare enough to cost nothing. */
export const POLL_MS = 2_000

interface TriageList {
  readonly tasks: readonly Task[]
  readonly pending: number
}

function useTriage(api: ViewProps['api']) {
  const [list, setList] = useState<TriageList | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const reads = useRef({ started: 0, applied: 0 })

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++reads.current.started
    try {
      const next = await api.get<TriageList>('triage')
      if (mine < reads.current.applied) return
      reads.current.applied = mine
      setList(next)
      setError(undefined)
    } catch (cause) {
      if (mine >= reads.current.applied) setError(messageOf(cause))
    }
  }, [api])

  useEffect(() => {
    void reload()
  }, [reload])

  const reading = list !== undefined && anyReading(list.tasks)
  useEffect(() => {
    if (!reading) return
    const tick = (): void => {
      if (document.visibilityState === 'visible') void reload()
    }
    const handle = window.setInterval(tick, POLL_MS)
    return () => window.clearInterval(handle)
  }, [reading, reload])

  return { list, error, reload }
}

export function Triage({ props }: { readonly props: ViewProps }) {
  const { api, navigate, openDrawer, pendingTotal } = props
  const board = useBoard(api)
  const triage = useTriage(api)
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())

  /** A change, then the list read again: what was accepted leaves it. */
  const act = useCallback(
    async (path: string, body?: unknown): Promise<boolean> => {
      const sent = await board.act(path, body)
      await triage.reload()
      return sent
    },
    [board, triage],
  )

  const decide = async (id: string, path: string, body?: unknown): Promise<void> => {
    setBusy((was) => new Set(was).add(id))
    await act(`tasks/${encodeURIComponent(id)}/${path}`, body)
    setBusy((was) => {
      const next = new Set(was)
      next.delete(id)
      return next
    })
  }

  const back = { label: 'Board', go: () => navigate('') }
  const bar = <PageBar title="Triage" back={back} pendingTotal={pendingTotal} onMenu={openDrawer} />
  const list = triage.list
  const view = board.view
  const now = new Date()
  const today = view === undefined ? '' : todayIn(view.timeZone)
  const error = board.error ?? triage.error

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
      <p class="t-triage-lead dim-2">
        {list.tasks.length === 0
          ? 'Nothing to sort. What the AI captures lands here first.'
          : `${list.tasks.length} to sort. Nothing reaches the board until you accept it.`}
      </p>
      {error === undefined ? null : (
        <div class="t-pad-x">
          <ErrorNotice message={error} action={{ label: 'Dismiss', run: board.clearError }} />
        </div>
      )}
      <ul class="t-triage-list" aria-label="Cards in Triage">
        {list.tasks.map((task) => (
          <TriageItem
            key={task.id}
            task={task}
            now={now}
            today={today}
            busy={busy.has(task.id)}
            accept={(to) => void decide(task.id, 'accept', { to })}
            discard={() => void decide(task.id, 'remove')}
            edit={() => setEditing(task.id)}
          />
        ))}
      </ul>
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
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  )
}

function TriageItem({
  task,
  now,
  today,
  busy,
  accept,
  discard,
  edit,
}: {
  readonly task: Task
  readonly now: Date
  readonly today: string
  readonly busy: boolean
  readonly accept: (to: 'todo' | 'backlog') => void
  readonly discard: () => void
  readonly edit: () => void
}) {
  const source = sourceOf(task)
  const reading = readingOf(task)
  const wrote = wroteOf(task)
  const late = task.due !== null && today !== '' && task.due < today
  return (
    <li class="t-triage-item" aria-busy={reading === 'reading'}>
      <p class="t-triage-src">
        <Icon name={source.kind === 'agent' ? 'terminal-window' : 'sparkle'} size={14} />
        {source.label} · {agoOf(task.createdAt, now)}
      </p>
      <h2 class="t-triage-title">{task.title}</h2>
      {reading === 'reading' ? (
        <p class="t-triage-reading" role="status">
          <Icon name="circle-notch" size={14} class="t-spin" />
          Reading it…
        </p>
      ) : null}
      {reading === 'failed' ? <p class="t-triage-failed">Couldn't parse it: the text is kept as the title.</p> : null}
      <Fields task={task} late={late} />
      {wrote === undefined ? null : <p class="t-triage-raw dim-2">You wrote: «{wrote}»</p>}
      <div class="t-triage-acts">
        <button type="button" class="btn" disabled={busy} onClick={() => accept('todo')}>
          To Todo
        </button>
        <button type="button" class="btn" disabled={busy} onClick={() => accept('backlog')}>
          To Backlog
        </button>
        <button type="button" class="icon-btn" aria-label={`Edit ${task.title} before accepting`} disabled={busy} onClick={edit}>
          <Icon name="pencil-simple" size={20} />
        </button>
        <button type="button" class="icon-btn t-triage-discard" aria-label={`Discard ${task.title}`} disabled={busy} onClick={discard}>
          <Icon name="trash" size={20} />
        </button>
      </div>
    </li>
  )
}

/** What claude deduced, in one line: priority, due date, area, project. Nothing when it deduced nothing. */
function Fields({ task, late }: { readonly task: Task; readonly late: boolean }) {
  if (task.priority === 0 && task.due === null && task.area === null && task.project === null) return null
  return (
    <p class="t-triage-fields">
      {task.priority === 0 ? null : <PriorityGlyph priority={task.priority} labelled />}
      {task.due === null ? null : (
        <span class={late ? 't-overdue' : undefined}>
          <Icon name={late ? 'warning' : 'calendar-blank'} size={13} />
          {shortDay(task.due)}
        </span>
      )}
      {task.area === null ? null : <span>{task.area}</span>}
      {task.project === null ? null : <ProjectTag siteId={task.project.siteId} />}
    </p>
  )
}
