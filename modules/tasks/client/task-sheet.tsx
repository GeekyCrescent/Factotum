/**
 * One card, as a sheet (design D11; criteria 10 and 12; S10).
 *
 * THE FIELDS are edited in a draft and saved together; only what changed is sent (`patchOf`), and a
 * `400` names the field. SUBTASKS AND «MOVE TO…» go at once: ticking a box is not an edit to review.
 *
 * A CARD OF A CLOSED CYCLE is read from `GET /tasks/:id` and shown read-only: its history is a copy.
 * DELETING asks first (S10); there is no undo, and no backup (requirements §2).
 */

import { useEffect, useState } from 'preact/hooks'
import type { BoardView, Task } from '../types.ts'
import type { Api } from './contract.ts'
import { Icon } from './icon.tsx'
import { COLUMNS, draftOf, ESTIMATES, labelOf, messageOf, patchOf, PRIORITIES, progressOf, projectOf, statusOf, type Draft } from './model.ts'
import { Sheet } from './sheet.tsx'

interface Props {
  readonly api: Api
  readonly id: string
  readonly view: BoardView
  readonly act: (path: string, body?: unknown) => Promise<boolean>
  readonly error: string | undefined
  readonly onClose: () => void
}

export function TaskSheet({ api, id, view, act, error, onClose }: Props) {
  const live = view.tasks.find((task) => task.id === id)
  const [fetched, setFetched] = useState<Task | null | undefined>(undefined)
  const [fetchError, setFetchError] = useState<string | undefined>(undefined)

  // Not on the board: a card of a closed cycle (or of triage), read by id.
  useEffect(() => {
    if (live !== undefined) return
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
  }, [api, id, live === undefined])

  const task = live ?? fetched ?? undefined
  if (task === undefined) {
    return (
      <Sheet id="t-card-title" title={fetched === null ? 'Card not found' : 'Card'} onClose={onClose}>
        <p class="dim-2">{fetched === null ? 'This card is not on the board any more.' : (fetchError ?? 'Loading…')}</p>
      </Sheet>
    )
  }
  return <Editor task={task} readOnly={live === undefined} view={view} act={act} error={error} onClose={onClose} />
}

function Editor({
  task,
  readOnly,
  view,
  act,
  error,
  onClose,
}: {
  readonly task: Task
  readonly readOnly: boolean
  readonly view: BoardView
  readonly act: Props['act']
  readonly error: string | undefined
  readonly onClose: () => void
}) {
  const [edits, setEdits] = useState<Partial<Draft>>({})
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [newSubtask, setNewSubtask] = useState('')
  const draft: Draft = { ...draftOf(task), ...edits }
  const patch = patchOf(task, draft)
  const dirty = Object.keys(patch).length > 0
  const path = `tasks/${encodeURIComponent(task.id)}`
  const project = projectOf(draft.project)

  const edit = (key: keyof Draft) => (event: Event) =>
    setEdits((was) => ({ ...was, [key]: (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value }))

  const setProject = (host: string, siteId: string): void =>
    setEdits((was) => ({ ...was, project: siteId.trim() === '' ? '' : `${host.trim()}/${siteId.trim()}` }))

  const save = async (): Promise<void> => {
    setSaving(true)
    if (await act(path, patch)) setEdits({})
    setSaving(false)
  }

  const subtasks = (next: readonly { id?: string; text: string; done: boolean }[]): Promise<boolean> => act(path, { subtasks: next })
  const toggle = (id: string): void =>
    void subtasks(task.subtasks.map((s) => (s.id === id ? { ...s, done: !s.done } : s)))
  const dropSubtask = (id: string): void => void subtasks(task.subtasks.filter((s) => s.id !== id))
  const addSubtask = async (event: Event): Promise<void> => {
    event.preventDefault()
    const text = newSubtask.trim()
    if (text === '') return
    if (await subtasks([...task.subtasks, { text, done: false }])) setNewSubtask('')
  }

  const remove = async (): Promise<void> => {
    if (await act(`${path}/remove`)) onClose()
  }

  const progress = progressOf(task)

  return (
    <Sheet id="t-card-title" title={readOnly ? 'Card (read-only)' : 'Card'} onClose={onClose}>
      {error === undefined ? null : (
        <div class="notice err" role="alert">
          <p>{error}</p>
        </div>
      )}

      <label class="t-field">
        <span>Title</span>
        <input type="text" value={draft.title} maxLength={200} disabled={readOnly} onInput={edit('title')} />
      </label>

      <div class="t-row">
        <span class="chip">{labelOf(task.status)}</span>
        {task.cycle === null ? null : <span class="chip num">{task.cycle.slice(5)}</span>}
        {readOnly ? null : (
          <label class="t-move">
            <span class="sr-only">Move to…</span>
            <select
              value=""
              aria-label="Move to…"
              onChange={(event) => {
                const status = (event.target as HTMLSelectElement).value
                if (status !== '') void act(`${path}/move`, { status })
              }}
            >
              <option value="">Move to…</option>
              {COLUMNS.filter((c) => c.status !== task.status).map((c) => (
                <option key={c.status} value={c.status}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <label class="t-field">
        <span>Notes</span>
        <textarea rows={4} value={draft.notes} maxLength={4000} disabled={readOnly} onInput={edit('notes')} />
      </label>

      <div class="t-grid">
        <label class="t-field">
          <span>Area</span>
          <input type="text" list="t-areas" value={draft.area} maxLength={40} disabled={readOnly} onInput={edit('area')} />
          <datalist id="t-areas">
            {view.areas.map((area) => (
              <option key={area} value={area} />
            ))}
          </datalist>
        </label>
        <label class="t-field">
          <span>Priority</span>
          <select value={draft.priority} disabled={readOnly} onChange={edit('priority')}>
            {PRIORITIES.map((p) => (
              <option key={p.value} value={String(p.value)}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label class="t-field">
          <span>Estimate</span>
          <select value={draft.estimate} disabled={readOnly} onChange={edit('estimate')}>
            {ESTIMATES.map((e) => (
              <option key={String(e)} value={e === null ? '' : String(e)}>
                {e === null ? 'None' : String(e)}
              </option>
            ))}
          </select>
        </label>
        <label class="t-field">
          <span>Due</span>
          <input type="date" value={draft.due} disabled={readOnly} onInput={edit('due')} />
        </label>
        <label class="t-field">
          <span>Reminder</span>
          <input type="datetime-local" value={draft.remind} disabled={readOnly} onInput={edit('remind')} />
        </label>
        <label class="t-field">
          <span>Labels</span>
          <input type="text" value={draft.labels} placeholder="uni, writing" disabled={readOnly} onInput={edit('labels')} />
        </label>
        <label class="t-field">
          <span>Project</span>
          <input
            type="text"
            list="t-projects"
            value={project?.siteId ?? ''}
            placeholder="none"
            disabled={readOnly}
            onInput={(event) => setProject(project?.host ?? '', (event.target as HTMLInputElement).value)}
          />
          <datalist id="t-projects">
            {[...new Set(view.projects.map((p) => p.siteId))].map((siteId) => (
              <option key={siteId} value={siteId} />
            ))}
          </datalist>
        </label>
        <label class="t-field">
          <span>Project host</span>
          <input
            type="text"
            value={project?.host ?? ''}
            placeholder="this board's host"
            disabled={readOnly || project === null}
            onInput={(event) => setProject((event.target as HTMLInputElement).value, project?.siteId ?? '')}
          />
        </label>
      </div>

      {task.remindedAt !== null ? <p class="dim-3">Reminder sent.</p> : task.reminderMissed ? <p class="t-overdue">Reminder missed.</p> : null}

      {readOnly ? null : (
        <div class="t-acts">
          <button type="button" class="btn primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {dirty ? (
            <button type="button" class="btn quiet" onClick={() => setEdits({})}>
              Discard changes
            </button>
          ) : null}
        </div>
      )}

      <section class="t-subtasks" aria-label="Subtasks">
        <h3>
          Subtasks {progress === undefined ? null : <span class="num dim-3">{progress}</span>}
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
                onClick={() => toggle(subtask.id)}
              >
                <Icon name={subtask.done ? 'check-square' : 'square'} size={18} />
              </button>
              <span class={subtask.done ? 't-subtask-done' : undefined}>{subtask.text}</span>
              {readOnly ? null : (
                <button type="button" class="icon-btn" aria-label={`Remove ${subtask.text}`} onClick={() => dropSubtask(subtask.id)}>
                  <Icon name="x" size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
        {readOnly || task.subtasks.length >= 30 ? null : (
          <form class="t-capture" onSubmit={(event) => void addSubtask(event)}>
            <input
              class="t-capture-input"
              type="text"
              value={newSubtask}
              maxLength={200}
              placeholder="Add a subtask"
              aria-label="New subtask"
              onInput={(event) => setNewSubtask((event.target as HTMLInputElement).value)}
            />
            <button type="submit" class="icon-btn" aria-label="Add subtask" disabled={newSubtask.trim() === ''}>
              <Icon name="plus" size={18} />
            </button>
          </form>
        )}
      </section>

      <p class="dim-3 t-provenance">
        {task.source.kind === 'owner' ? 'Added by you' : task.source.kind === 'capture' ? 'Captured' : 'Agent'} ·{' '}
        {new Date(task.createdAt).toLocaleDateString()}
        {task.completedAt === null ? '' : ` · done ${new Date(task.completedAt).toLocaleDateString()}`}
        {task.sessions.length === 0 ? '' : ` · ${task.sessions.length} linked session${task.sessions.length === 1 ? '' : 's'}`}
      </p>

      {readOnly ? null : confirming ? (
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
      ) : (
        <button type="button" class="btn quiet t-delete" onClick={() => setConfirming(true)}>
          <Icon name="trash" size={16} /> Delete card
        </button>
      )}
    </Sheet>
  )
}
