/**
 * One card, as a sheet (design D11; criteria 10 and 12; S10), laid out as redesign A: the title as
 * the first field, then the card's properties as rows — a label and its value, each row one control —
 * then subtasks and notes. The head is only a crumb: where the card is («Todo · W42»).
 *
 * THE FIELDS are edited in a draft and saved together; only what changed is sent (`patchOf`), and a
 * `400` names the field. SUBTASKS AND «MOVE TO…» go at once: ticking a box is not an edit to review.
 *
 * A CARD OF A CLOSED CYCLE is read from `GET /tasks/:id` and shown read-only: its history is a copy.
 * DELETING asks first (S10); there is no undo, and no backup (requirements §2).
 *
 * SAVE lives in the sheet's foot, and only while there is something to save: «2 changes · Discard ·
 * Save», in reach of the thumb.
 */

import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { BoardView, Task } from '../types.ts'
import type { Api } from './contract.ts'
import { PriorityGlyph, StatusGlyph } from './glyphs.tsx'
import { Icon } from './icon.tsx'
import {
  addedSubtasks,
  COLUMNS,
  draftOf,
  droppedSubtasks,
  ESTIMATES,
  isOverdue,
  labelOf,
  lateBy,
  messageOf,
  patchOf,
  PRIORITIES,
  progressOf,
  projectOf,
  statusOf,
  toggledSubtasks,
  type Column,
  type Draft,
} from './model.ts'
import type { CaptureProject } from './agent-model.ts'
import type { Edge } from './edge.ts'
import { SessionsPanel } from './sessions-panel.tsx'
import { Sheet } from './sheet.tsx'

interface Props {
  readonly api: Api
  readonly id: string
  readonly view: BoardView
  /** `YYYY-MM-DD` in the board's zone: what a due date is late against. */
  readonly today: string
  readonly act: (path: string, body?: unknown) => Promise<boolean>
  readonly error: string | undefined
  readonly onClose: () => void
  /** The edge to the sessions module: «Run agent» and the linked sessions. Without it, neither shows. */
  readonly edge?: Edge
  /** The projects of every reachable host, for the project field; the hosts as the board stores them. */
  readonly hostProjects?: readonly CaptureProject[]
}

export function TaskSheet({ api, id, view, today, act, error, onClose, edge, hostProjects }: Props) {
  const live = view.tasks.find((task) => task.id === id)
  const [fetched, setFetched] = useState<Task | null | undefined>(undefined)
  const [fetchError, setFetchError] = useState<string | undefined>(undefined)
  // The card as it was last seen on the board. When it leaves — deleted from here, or its cycle
  // closed on another device — the sheet keeps showing it, read-only, instead of flashing «not found».
  const lastSeen = useRef<Task | undefined>(undefined)
  if (live !== undefined) lastSeen.current = live
  const neverOnBoard = lastSeen.current === undefined

  // Never on the board: a card of a closed cycle (or of triage), read by id.
  useEffect(() => {
    if (!neverOnBoard) return
    let current = true
    api
      .get<Task>(`tasks/${encodeURIComponent(id)}`)
      .then((task) => current && setFetched(task))
      .catch((cause: unknown) => {
        if (!current) return
        if (statusOf(cause) === 404) setFetched(null)
        else setFetchError(messageOf(cause))
      })
    return () => {
      current = false
    }
  }, [api, id, neverOnBoard])

  const task = live ?? lastSeen.current ?? fetched ?? undefined
  if (task === undefined) {
    return (
      <Sheet id="t-card-title" title={fetched === null ? 'Card not found' : 'Card'} onClose={onClose}>
        <p class="dim-2">{fetched === null ? 'This card is not on the board any more.' : (fetchError ?? 'Loading…')}</p>
      </Sheet>
    )
  }
  return (
    <Editor
      task={task}
      readOnly={live === undefined}
      view={view}
      today={today}
      act={act}
      error={error}
      onClose={onClose}
      {...(edge === undefined ? {} : { edge })}
      {...(hostProjects === undefined ? {} : { hostProjects })}
    />
  )
}

type Act = Props['act']

function crumbOf(task: Task, readOnly: boolean) {
  const where = [labelOf(task.status), task.cycle === null ? undefined : task.cycle.slice(5), readOnly ? 'read-only' : undefined]
  return (
    <>
      {task.status === 'triage' ? null : <StatusGlyph status={task.status} />}
      {where.filter((part) => part !== undefined).join(' · ')}
    </>
  )
}

function Editor({
  task,
  readOnly,
  view,
  today,
  act,
  error,
  onClose,
  edge,
  hostProjects,
}: {
  readonly task: Task
  readonly readOnly: boolean
  readonly view: BoardView
  readonly today: string
  readonly act: Act
  readonly error: string | undefined
  readonly onClose: () => void
  readonly edge?: Edge
  readonly hostProjects?: readonly CaptureProject[]
}) {
  const [edits, setEdits] = useState<Partial<Draft>>({})
  const [saving, setSaving] = useState(false)
  const draft: Draft = { ...draftOf(task), ...edits }
  const patch = patchOf(task, draft)
  const changes = Object.keys(patch).length
  const path = `tasks/${encodeURIComponent(task.id)}`
  const edit = (key: keyof Draft, value: string): void => setEdits((was) => ({ ...was, [key]: value }))

  const save = async (): Promise<void> => {
    setSaving(true)
    if (await act(path, patch)) setEdits({})
    setSaving(false)
  }

  const foot =
    readOnly || changes === 0 ? undefined : (
      <>
        <span class="t-changes num">{changes === 1 ? '1 change' : `${changes} changes`}</span>
        <button type="button" class="btn quiet" onClick={() => setEdits({})}>
          Discard
        </button>
        <button type="button" class="btn primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </>
    )

  return (
    <Sheet id="t-card-crumb" title={crumbOf(task, readOnly)} crumb onClose={onClose} {...(foot === undefined ? {} : { foot })}>
      {error === undefined ? null : (
        <div class="notice err" role="alert">
          <p>{error}</p>
        </div>
      )}
      <textarea
        class="t-title-field"
        rows={1}
        value={draft.title}
        maxLength={200}
        aria-label="Title"
        disabled={readOnly}
        // A title is one line: a pasted line break becomes a space, as an <input> would drop it.
        onInput={(event) => edit('title', (event.target as HTMLTextAreaElement).value.replace(/\s*\n\s*/g, ' '))}
        onKeyDown={(event) => {
          // Enter saves, as in any other field — but not the Enter that confirms an IME candidate.
          if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault()
            if (changes > 0 && !saving) void save()
          }
        }}
      />
      <Properties
        task={task}
        draft={draft}
        readOnly={readOnly}
        view={view}
        today={today}
        edit={edit}
        act={act}
        path={path}
        hostProjects={hostProjects ?? []}
      />
      <Subtasks task={task} readOnly={readOnly} act={act} path={path} />
      <label class="t-notes">
        <span>Notes</span>
        <textarea rows={3} value={draft.notes} maxLength={4000} placeholder="Add notes" disabled={readOnly} onInput={(event) => edit('notes', (event.target as HTMLTextAreaElement).value)} />
      </label>
      {edge === undefined ? null : <SessionsPanel task={task} edge={edge} readOnly={readOnly} act={act} />}
      {task.remindedAt !== null ? <p class="dim-2">Reminder sent.</p> : task.reminderMissed ? <p class="t-overdue">Reminder missed.</p> : null}
      <p class="dim-2 t-provenance">
        {task.source.kind === 'owner' ? 'Added by you' : task.source.kind === 'capture' ? 'Captured' : 'Agent'} · {new Date(task.createdAt).toLocaleDateString()}
        {task.completedAt === null ? '' : ` · done ${new Date(task.completedAt).toLocaleDateString()}`}
        {task.sessions.length === 0 ? '' : ` · ${task.sessions.length} linked session${task.sessions.length === 1 ? '' : 's'}`}
      </p>
      {readOnly ? null : <Delete act={act} path={path} onClose={onClose} />}
    </Sheet>
  )
}

/** One row: the label on the left, the control on the right, the whole row its target. */
function Prop({ label, children, late = false }: { readonly label: string; readonly children: ComponentChildren; readonly late?: boolean }) {
  return (
    <label class={late ? 't-prop t-prop-late' : 't-prop'}>
      <span class="t-prop-k">{label}</span>
      <span class="t-prop-v">{children}</span>
    </label>
  )
}

function Properties({
  task,
  draft,
  readOnly,
  view,
  today,
  edit,
  act,
  path,
  hostProjects,
}: {
  readonly task: Task
  readonly draft: Draft
  readonly readOnly: boolean
  readonly view: BoardView
  readonly today: string
  readonly edit: (key: keyof Draft, value: string) => void
  readonly act: Act
  readonly path: string
  readonly hostProjects: readonly CaptureProject[]
}) {
  const project = projectOf(draft.project)
  const value = (event: Event): string => (event.target as HTMLInputElement | HTMLSelectElement).value
  const setProject = (host: string, siteId: string): void => edit('project', siteId.trim() === '' ? '' : `${host.trim()}/${siteId.trim()}`)
  const late = isOverdue(task, today) && task.due !== null ? lateBy(task.due, today) : undefined
  return (
    <div class="t-props">
      {task.status === 'triage' ? null : (
        <Prop label="Status">
          <StatusGlyph status={task.status} />
          {/* Goes at once, like a drag: a move is not an edit to review (criterion 7). */}
          <select value={task.status} disabled={readOnly} onChange={(event) => void act(`${path}/move`, { status: value(event) as Column })}>
            {COLUMNS.map((c) => (
              <option key={c.status} value={c.status}>
                {c.label}
              </option>
            ))}
          </select>
        </Prop>
      )}
      <Prop label="Priority">
        <PriorityGlyph priority={Number(draft.priority) as Task['priority']} />
        <select value={draft.priority} disabled={readOnly} onChange={(event) => edit('priority', value(event))}>
          {PRIORITIES.map((p) => (
            <option key={p.value} value={String(p.value)}>
              {p.label}
            </option>
          ))}
        </select>
      </Prop>
      <Prop label="Due" late={late !== undefined}>
        <input type="date" value={draft.due} disabled={readOnly} onInput={(event) => edit('due', value(event))} />
        {late === undefined ? null : <span class="t-late-by">{late}</span>}
      </Prop>
      <Prop label="Reminder">
        <input type="datetime-local" value={draft.remind} disabled={readOnly} onInput={(event) => edit('remind', value(event))} />
      </Prop>
      <Prop label="Estimate">
        <select value={draft.estimate} disabled={readOnly} onChange={(event) => edit('estimate', value(event))}>
          {ESTIMATES.map((e) => (
            <option key={String(e)} value={e === null ? '' : String(e)}>
              {e === null ? 'None' : e === 1 ? '1 point' : `${e} points`}
            </option>
          ))}
        </select>
      </Prop>
      <Prop label="Area">
        <input type="text" list="t-areas" value={draft.area} maxLength={40} placeholder="None" disabled={readOnly} onInput={(event) => edit('area', value(event))} />
        <datalist id="t-areas">
          {view.areas.map((area) => (
            <option key={area} value={area} />
          ))}
        </datalist>
      </Prop>
      <Prop label="Labels">
        <input type="text" value={draft.labels} placeholder="uni, writing" disabled={readOnly} onInput={(event) => edit('labels', value(event))} />
      </Prop>
      {hostProjects.length > 0 ? (
        // The projects the hosts have, by name: the value is the stored key, `<host>/<siteId>`.
        <Prop label="Project">
          <select value={draft.project} disabled={readOnly} onChange={(event) => edit('project', value(event))}>
            <option value="">None</option>
            {project !== null && !hostProjects.some((p) => p.siteId === project.siteId && p.host === project.host) ? (
              <option value={draft.project}>
                {project.siteId}
                {project.host === null ? '' : ` · ${project.host}`}
              </option>
            ) : null}
            {hostProjects.map((p) => (
              <option key={`${p.host ?? ''}/${p.siteId}`} value={`${p.host ?? ''}/${p.siteId}`}>
                {p.name}
                {p.host === null ? '' : ` · ${p.host}`}
              </option>
            ))}
          </select>
        </Prop>
      ) : (
        <>
          <Prop label="Project">
            <input type="text" list="t-projects" value={project?.siteId ?? ''} placeholder="None" disabled={readOnly} onInput={(event) => setProject(project?.host ?? '', value(event))} />
            <datalist id="t-projects">
              {[...new Set(view.projects.map((p) => p.siteId))].map((siteId) => (
                <option key={siteId} value={siteId} />
              ))}
            </datalist>
          </Prop>
          {project === null ? null : (
            <Prop label="Project host">
              <input type="text" value={project.host ?? ''} placeholder="This board's host" disabled={readOnly} onInput={(event) => setProject(value(event), project.siteId)} />
            </Prop>
          )}
        </>
      )}
    </div>
  )
}

function Subtasks({ task, readOnly, act, path }: { readonly task: Task; readonly readOnly: boolean; readonly act: Act; readonly path: string }) {
  const [text, setText] = useState('')
  // Two Enters before the first answer would add the subtask twice.
  const adding = useRef(false)
  // Built WHEN ITS TURN COMES in the queue, from the card as the previous change left it: two quick
  // ticks both land (review of block K).
  const change = (next: (current: Task) => unknown): Promise<boolean> =>
    act(path, (latest: BoardView | undefined) => ({ subtasks: next(latest?.tasks.find((t) => t.id === task.id) ?? task) }))
  const add = async (event: Event): Promise<void> => {
    event.preventDefault()
    const trimmed = text.trim()
    if (trimmed === '' || adding.current) return
    adding.current = true
    if (await change((current) => addedSubtasks(current, trimmed))) setText('')
    adding.current = false
  }
  const progress = progressOf(task)
  return (
    <section class="t-subtasks" aria-label="Subtasks">
      <h3>
        Subtasks {progress === undefined ? null : <span class="num dim-2">{progress}</span>}
      </h3>
      <ul>
        {task.subtasks.map((subtask) => (
          <li key={subtask.id} class="t-subtask">
            <button
              type="button"
              class="icon-btn"
              role="checkbox"
              aria-checked={subtask.done}
              aria-label={subtask.text}
              disabled={readOnly}
              onClick={() => void change((current) => toggledSubtasks(current, subtask.id))}
            >
              <Icon name={subtask.done ? 'check-square' : 'square'} size={20} />
            </button>
            <span class={subtask.done ? 't-subtask-done' : undefined}>{subtask.text}</span>
            {readOnly ? null : (
              <button type="button" class="icon-btn" aria-label={`Remove ${subtask.text}`} onClick={() => void change((current) => droppedSubtasks(current, subtask.id))}>
                <Icon name="x" size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {readOnly || task.subtasks.length >= 30 ? null : (
        <form class="t-subtask-add" onSubmit={(event) => void add(event)}>
          <Icon name="plus" size={16} />
          <input
            type="text"
            value={text}
            maxLength={200}
            placeholder="Add a subtask"
            aria-label="New subtask"
            onInput={(event) => setText((event.target as HTMLInputElement).value)}
          />
          <button type="submit" class="icon-btn" aria-label="Add subtask" disabled={text.trim() === ''}>
            <Icon name="plus" size={18} />
          </button>
        </form>
      )}
    </section>
  )
}

function Delete({ act, path, onClose }: { readonly act: Act; readonly path: string; readonly onClose: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const remove = async (): Promise<void> => {
    if (await act(`${path}/remove`)) onClose()
  }
  if (!confirming) {
    return (
      <button type="button" class="btn quiet t-delete" onClick={() => setConfirming(true)}>
        <Icon name="trash" size={16} /> Delete card
      </button>
    )
  }
  return (
    <div class="notice err">
      <div class="head">Delete this card?</div>
      <p>It cannot be undone.</p>
      <div class="acts">
        <button type="button" class="btn sm" onClick={() => void remove()}>
          Delete
        </button>
        <button type="button" class="btn sm quiet" onClick={() => setConfirming(false)}>
          Keep
        </button>
      </div>
    </div>
  )
}
