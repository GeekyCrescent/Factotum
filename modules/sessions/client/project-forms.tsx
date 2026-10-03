/**
 * The dialogs of the projects screen: a new project, a shared folder, editing a project (with
 * deleting it at the bottom), and the confirmations that delete (spec 2026-09-29, D10; redesigned
 * 2026-09-30).
 *
 * THE ID TYPED HERE IS A SUGGESTION, and it lives under Advanced options: the daemon derives the real
 * one from the RESOLVED folder's name — a symlink registers where it lands (criterion 13) — so the
 * placeholder is only a guess from what was typed. An id typed on purpose is sent and validated there.
 */

import { useState } from 'preact/hooks'
import type { Color } from '../types.ts'
import { messageOf } from './errors.ts'
import { Icon } from './icon.tsx'
import { Sheet } from './sheet.tsx'
import { PROJECT_TONES } from './tone.ts'

const NAME_MAX = 40
const COLORS = Array.from({ length: PROJECT_TONES }, (_, i) => (i + 1) as Color)

/** A folder name turned into the id the daemon would probably pick. Only a placeholder. */
export function guessId(path: string): string {
  const base = path.replace(/\/+$/, '').split('/').pop() ?? ''
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function ColorPicker({ value, onPick }: { readonly value: Color | undefined; readonly onPick: (color: Color | undefined) => void }) {
  return (
    <div class="s-colors" role="radiogroup" aria-label="Colour">
      {COLORS.map((color) => (
        <button
          type="button"
          key={color}
          role="radio"
          aria-checked={value === color}
          aria-label={`Colour ${color}`}
          class={`s-swatch s-p${color}`}
          onClick={() => onPick(value === color ? undefined : color)}
        >
          {value === color ? <Icon name="check" size={16} /> : null}
        </button>
      ))}
    </div>
  )
}

/** Runs a request from a dialog: busy while it runs, its failure shown inside the dialog. */
function useSubmit() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const submit = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await work()
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, submit }
}

/** What adding needs to say: the phone confirms it, or there is nobody to confirm and what to do. */
function Approval({ canRequest, file }: { readonly canRequest: boolean; readonly file: string }) {
  return canRequest ? (
    <p class="s-callout">
      <Icon name="device-mobile" size={18} />
      You'll confirm access on your phone.
    </p>
  ) : (
    <p class="s-callout s-callout-warn">
      <Icon name="warning" size={18} />
      <span>
        No device can approve right now. Turn on notifications in Settings, or stop the daemon, add an entry to{' '}
        <span class="mono">{file}</span>, and start it again.
      </span>
    </p>
  )
}

function Buttons({ busy, disabled, action, onCancel }: { readonly busy: boolean; readonly disabled: boolean; readonly action: string; readonly onCancel: () => void }) {
  return (
    <div class="s-dialog-acts">
      <button type="button" class="btn" onClick={onCancel}>
        Cancel
      </button>
      <button type="submit" class="btn primary" disabled={busy || disabled}>
        {action}
      </button>
    </div>
  )
}

export interface NewProject {
  readonly path: string
  readonly id: string | undefined
  readonly name: string | undefined
  readonly color: Color | undefined
}

export function NewProjectDialog({
  canRequest,
  file,
  onCreate,
  onClose,
}: {
  readonly canRequest: boolean
  readonly file: string
  readonly onCreate: (project: NewProject) => Promise<void>
  readonly onClose: () => void
}) {
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [color, setColor] = useState<Color | undefined>(undefined)
  const [advanced, setAdvanced] = useState(false)
  const { busy, error, submit } = useSubmit()
  const guess = guessId(path)
  return (
    <Sheet id="s-new-project" title="New project" onClose={onClose}>
      <form
        class="s-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (path.trim() === '') return
          void submit(() =>
            onCreate({ path: path.trim(), id: id.trim() === '' ? undefined : id.trim(), name: name.trim() === '' ? undefined : name.trim(), color }),
          )
        }}
      >
        <label class="s-field">
          <span>Folder</span>
          <input class="s-input mono" value={path} placeholder="~/code/my-project" autoFocus autoCapitalize="off" autoCorrect="off" spellcheck={false} onInput={(e) => setPath((e.target as HTMLInputElement).value)} />
          <small>The folder on this Mac that agents may write in.</small>
        </label>
        <label class="s-field">
          <span>Project name</span>
          <input class="s-input" value={name} maxLength={NAME_MAX} placeholder="My project" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          <small>A short, descriptive name. Optional.</small>
        </label>
        <div class="s-field">
          <span>Color</span>
          <ColorPicker value={color} onPick={setColor} />
          <small>Helps you tell your projects apart.</small>
        </div>
        <button type="button" class="s-disclose" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
          <Icon name={advanced ? 'caret-down' : 'caret-right'} size={14} />
          Advanced options
        </button>
        {advanced ? (
          <label class="s-field">
            <span>Id</span>
            <input class="s-input mono" value={id} placeholder={guess === '' ? 'my-project' : guess} autoCapitalize="off" autoCorrect="off" spellcheck={false} onInput={(e) => setId((e.target as HTMLInputElement).value)} />
            <small>It comes from the folder's real name unless you type one.</small>
          </label>
        ) : null}
        <Approval canRequest={canRequest} file={file} />
        {error === undefined ? null : <p class="s-error" role="alert">{error}</p>}
        <Buttons busy={busy} disabled={path.trim() === ''} action="Create project" onCancel={onClose} />
      </form>
    </Sheet>
  )
}

export function AddFolderDialog({
  canRequest,
  file,
  onAdd,
  onClose,
}: {
  readonly canRequest: boolean
  readonly file: string
  readonly onAdd: (path: string) => Promise<void>
  readonly onClose: () => void
}) {
  const [path, setPath] = useState('')
  const { busy, error, submit } = useSubmit()
  return (
    <Sheet id="s-add-folder" title="Add a shared folder" onClose={onClose}>
      <form
        class="s-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (path.trim() !== '') void submit(() => onAdd(path.trim()))
        }}
      >
        <label class="s-field">
          <span>Folder</span>
          <input class="s-input mono" value={path} placeholder="~/Notes" autoFocus autoCapitalize="off" autoCorrect="off" spellcheck={false} onInput={(e) => setPath((e.target as HTMLInputElement).value)} />
          <small>Agents in every project may write here, and nothing locks it. It changes only while no session runs.</small>
        </label>
        <Approval canRequest={canRequest} file={file} />
        {error === undefined ? null : <p class="s-error" role="alert">{error}</p>}
        <Buttons busy={busy} disabled={path.trim() === ''} action="Add folder" onCancel={onClose} />
      </form>
    </Sheet>
  )
}

/** Name and colour, and — at the bottom, apart — deleting the project. */
/**
 * Several sessions at once (spec 2026-10-03-varias-sesiones-por-proyecto, D9). A real switch — a
 * button with `role="switch"` — because there was none in the client to reuse. The help says the two
 * things the owner accepted: agents may overwrite each other, and turning it off stops nobody.
 */
function ConcurrentSwitch({ on, onToggle }: { readonly on: boolean; readonly onToggle: (on: boolean) => void }) {
  return (
    <div class="s-toggle">
      <div>
        <b id="s-concurrent-label">Several sessions at once</b>
        <small id="s-concurrent-help">
          Several agents can work here at the same time, and may overwrite each other if they edit the same file. Turning it off
          does not stop the ones already running.
        </small>
      </div>
      <button type="button" class="s-switch" role="switch" aria-checked={on} aria-labelledby="s-concurrent-label"
        aria-describedby="s-concurrent-help"
        onClick={() => onToggle(!on)}>
        <span aria-hidden="true" />
      </button>
    </div>
  )
}

export function EditProjectDialog({
  id,
  name,
  color,
  concurrent,
  onSave,
  onDelete,
  onClose,
}: {
  readonly id: string
  readonly name: string | undefined
  readonly color: Color | undefined
  readonly concurrent: boolean
  readonly onSave: (name: string | undefined, color: Color | undefined, concurrent: boolean) => Promise<void>
  readonly onDelete: () => void
  readonly onClose: () => void
}) {
  const [draft, setDraft] = useState(name ?? '')
  const [tone, setTone] = useState<Color | undefined>(color)
  const [several, setSeveral] = useState(concurrent)
  const { busy, error, submit } = useSubmit()
  return (
    <Sheet id="s-edit-project" title={`Edit ${name ?? id}`} onClose={onClose}>
      <form
        class="s-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          void submit(() => onSave(draft.trim() === '' ? undefined : draft.trim(), tone, several))
        }}
      >
        <label class="s-field">
          <span>Project name</span>
          <input class="s-input" value={draft} maxLength={NAME_MAX} placeholder={id} autoFocus onInput={(e) => setDraft((e.target as HTMLInputElement).value)} />
        </label>
        <div class="s-field">
          <span>Color</span>
          <ColorPicker value={tone} onPick={setTone} />
        </div>
        <ConcurrentSwitch on={several} onToggle={setSeveral} />
        {error === undefined ? null : <p class="s-error" role="alert">{error}</p>}
        <Buttons busy={busy} disabled={false} action="Save" onCancel={onClose} />
        <div class="s-danger-zone">
          <div>
            <b>Delete project</b>
            <small>Deletes its conversations. The folder is not touched.</small>
          </div>
          <button type="button" class="btn danger" onClick={onDelete}>
            Delete
          </button>
        </div>
      </form>
    </Sheet>
  )
}

/**
 * Deleting a project: its conversations go, its folder does not. THE EXACT NAME IS TYPED before the
 * button works (criterion 27): a check of this screen's, the daemon's part is the lock.
 */
export function DeleteProjectSheet({
  label,
  total,
  busy,
  error,
  onDelete,
  onClose,
}: {
  readonly label: string
  readonly total: number
  readonly busy: boolean
  readonly error: string | undefined
  readonly onDelete: () => void
  readonly onClose: () => void
}) {
  const [typed, setTyped] = useState('')
  return (
    <Sheet id="s-delete-title" title={`Delete ${label}?`} onClose={onClose}>
      <p class="dim-2">
        Its {total === 1 ? 'conversation is' : `${total} conversations are`} deleted for good. Its folder and every file in it stay exactly as they
        are.
      </p>
      <label class="s-field">
        <span>Type {label} to confirm</span>
        <input class="s-input mono" value={typed} autoFocus autoCapitalize="off" autoCorrect="off" spellcheck={false} onInput={(e) => setTyped((e.target as HTMLInputElement).value)} />
      </label>
      {error === undefined ? null : <p class="s-error" role="alert">{error}</p>}
      <div class="s-dialog-acts">
        <button type="button" class="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" class="btn danger" disabled={busy || typed !== label} onClick={onDelete}>
          Delete project
        </button>
      </div>
    </Sheet>
  )
}

/** A plain confirmation, for what deletes and needs no typing. */
export function ConfirmSheet({
  title,
  body,
  action,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  readonly title: string
  readonly body: string
  readonly action: string
  readonly busy: boolean
  readonly error: string | undefined
  readonly onConfirm: () => void
  readonly onClose: () => void
}) {
  return (
    <Sheet id="s-confirm-title" title={title} onClose={onClose}>
      <p class="dim-2">{body}</p>
      {error === undefined ? null : <p class="s-error" role="alert">{error}</p>}
      <div class="s-dialog-acts">
        <button type="button" class="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" class="btn danger" disabled={busy} onClick={onConfirm}>
          {action}
        </button>
      </div>
    </Sheet>
  )
}
