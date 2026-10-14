/**
 * Triage, `/m/tasks/triage` (design D11; criteria 19–23c): what the AI created, waiting for the owner.
 * Nothing here is on the board until it is accepted — to Todo or to Backlog — and a card can be edited
 * first, in the same sheet as any card, or discarded without a question (S10).
 *
 * A CARD CLAUDE IS STILL READING says «Reading it…», and the list is read again every `POLL_MS` while
 * one is — and only while the screen is visible, for at most `POLL_TICKS` reads. When none is left, the
 * polling stops (crit. 23c). Coming back to the tab reads it again, as the board does.
 *
 * EDITING IS A ROUTE, `triage/<id>`: the phone's Back closes the sheet instead of leaving Triage.
 *
 * AFTER ACCEPTING OR DISCARDING, the focus goes to the card that took its place (or the lead, when the
 * list is empty), and one status line says what happened: the button that had it is gone.
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
/**
 * Two minutes of polling: a read times out at 30 s and waits at most behind a few others. A card still
 * `pending` after that is one a dead daemon left, which the next start settles.
 */
const POLL_TICKS = 60

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

  const [visits, setVisits] = useState(0)
  useEffect(() => {
    void reload()
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      void reload()
      setVisits((n) => n + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [reload])

  const reading = list !== undefined && anyReading(list.tasks)
  // `visits` re-arms a polling that ran out, when the owner comes back to the tab.
  useEffect(() => {
    if (!reading) return
    let ticks = 0
    const handle = window.setInterval(() => {
      if (++ticks >= POLL_TICKS) window.clearInterval(handle)
      if (document.visibilityState === 'visible') void reload()
    }, POLL_MS)
    return () => window.clearInterval(handle)
  }, [reading, reload, visits])

  const clearError = useCallback(() => setError(undefined), [])
  return { list, error, reload, clearError }
}

const DONE_LINE: Readonly<Record<'todo' | 'backlog' | 'discard', string>> = {
  todo: 'Moved to Todo.',
  backlog: 'Moved to Backlog.',
  discard: 'Discarded.',
}

export function Triage({ props, editing }: { readonly props: ViewProps; readonly editing: string | undefined }) {
  const { api, navigate, openDrawer, pendingTotal } = props
  const board = useBoard(api)
  const triage = useTriage(api)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [said, setSaid] = useState('')
  const [focusAt, setFocusAt] = useState<number | undefined>(undefined)
  const listRef = useRef<HTMLUListElement>(null)
  const leadRef = useRef<HTMLParagraphElement>(null)
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

  const decide = async (id: string, index: number, what: 'todo' | 'backlog' | 'discard'): Promise<void> => {
    if (busy.has(id)) return
    setBusy((was) => new Set(was).add(id))
    const path = `tasks/${encodeURIComponent(id)}/${what === 'discard' ? 'remove' : 'accept'}`
    const sent = await act(path, what === 'discard' ? undefined : { to: what })
    setBusy((was) => {
      const next = new Set(was)
      next.delete(id)
      return next
    })
    if (!sent) return
    setSaid(DONE_LINE[what])
    setFocusAt(index)
  }

  // After the list changed: the card that took the decided one's place, the one before it, or the lead.
  const tasks = triage.list?.tasks
  useEffect(() => {
    if (focusAt === undefined || tasks === undefined) return
    setFocusAt(undefined)
    const items = listRef.current?.querySelectorAll<HTMLElement>('[data-triage-first]') ?? []
    const target = items[Math.min(focusAt, items.length - 1)]
    if (target === undefined) leadRef.current?.focus()
    else target.focus()
  }, [focusAt, tasks])

  const back = { label: 'Board', go: () => navigate('') }
  const bar = <PageBar title="Triage" back={back} pendingTotal={pendingTotal} onMenu={openDrawer} />
  const list = triage.list
  const view = board.view
  const now = new Date()
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
      <p class="t-triage-lead dim-2" ref={leadRef} tabIndex={-1}>
        {list.tasks.length === 0
          ? 'Nothing to sort. What the AI captures lands here first.'
          : `${list.tasks.length} to sort. Nothing reaches the board until you accept it.`}
      </p>
      {/* One persistent region, so a screen reader hears what each decision did. */}
      <p class="sr-only" role="status">
        {said === '' ? '' : `${said} ${list.tasks.length === 0 ? 'Nothing left to sort.' : `${list.tasks.length} left.`}`}
      </p>
      {error === undefined ? null : (
        <div class="t-pad-x">
          <ErrorNotice message={error} action={{ label: 'Dismiss', run: dismiss }} />
        </div>
      )}
      <ul class="t-triage-list" aria-label="Cards in Triage" ref={listRef}>
        {list.tasks.map((task, index) => (
          <TriageItem
            key={task.id}
            task={task}
            now={now}
            today={today}
            busy={busy.has(task.id)}
            canEdit={view !== undefined}
            accept={(to) => void decide(task.id, index, to)}
            discard={() => void decide(task.id, index, 'discard')}
            edit={() => navigate(`triage/${encodeURIComponent(task.id)}`)}
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
          onClose={() => navigate('triage')}
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
  canEdit,
  accept,
  discard,
  edit,
}: {
  readonly task: Task
  readonly now: Date
  readonly today: string
  readonly busy: boolean
  /** The sheet needs the board (its areas, its zone): Edit waits for it. */
  readonly canEdit: boolean
  readonly accept: (to: 'todo' | 'backlog') => void
  readonly discard: () => void
  readonly edit: () => void
}) {
  const source = sourceOf(task)
  const reading = readingOf(task)
  const wrote = wroteOf(task)
  const late = task.due !== null && today !== '' && task.due < today
  return (
    <li class="t-triage-item">
      <p class="t-triage-src">
        <Icon name={source.kind === 'agent' ? 'terminal-window' : 'sparkle'} size={14} />
        {source.label} · {agoOf(task.createdAt, now)}
      </p>
      <h2 class="t-triage-title">{task.title}</h2>
      {reading === 'reading' ? (
        <p class="t-triage-reading">
          <Icon name="circle-notch" size={14} class="t-spin" />
          Reading it…
        </p>
      ) : null}
      {reading === 'failed' ? <p class="t-triage-failed">Couldn't parse it: the text is kept as the title.</p> : null}
      <Fields task={task} late={late} />
      {wrote === undefined ? null : <p class="t-triage-raw dim-2">You wrote: «{wrote}»</p>}
      <div class="t-triage-acts">
        {/* aria-disabled, not disabled: a disabled button drops the focus it holds (decide() guards a double tap). */}
        <button type="button" class="btn" data-triage-first aria-disabled={busy} onClick={() => accept('todo')}>
          To Todo
        </button>
        <button type="button" class="btn" aria-disabled={busy} onClick={() => accept('backlog')}>
          To Backlog
        </button>
        <button type="button" class="icon-btn" aria-label={`Edit ${task.title} before accepting`} disabled={!canEdit} onClick={edit}>
          <Icon name="pencil-simple" size={20} />
        </button>
        <button type="button" class="icon-btn t-triage-discard" aria-label={`Discard ${task.title}`} aria-disabled={busy} onClick={discard}>
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
