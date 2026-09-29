/**
 * The forms of the projects screen: add a project, add a shared folder, edit a name and a colour,
 * and the two confirmations that delete (spec 2026-09-29, D10).
 *
 * THE ID TYPED HERE IS A SUGGESTION. The daemon derives the real one from the RESOLVED folder's
 * name — a symlink registers where it lands (criterion 13) — so the placeholder is only a guess from
 * what was typed. An id typed on purpose is sent and validated there.
 */

import { useState } from 'preact/hooks'
import type { Color } from '../types.ts'
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
        />
      ))}
    </div>
  )
}

export interface NewProject {
  readonly path: string
  readonly id: string | undefined
  readonly name: string | undefined
  readonly color: Color | undefined
}

export function AddProjectForm({ busy, onSubmit }: { readonly busy: boolean; readonly onSubmit: (project: NewProject) => void }) {
  const [path, setPath] = useState('')
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [color, setColor] = useState<Color | undefined>(undefined)
  const guess = guessId(path)
  return (
    <form
      class="s-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (path.trim() === '' || busy) return
        onSubmit({ path: path.trim(), id: id.trim() === '' ? undefined : id.trim(), name: name.trim() === '' ? undefined : name.trim(), color })
      }}
    >
      <label class="s-field">
        <span>Folder</span>
        <input class="s-input mono" value={path} placeholder="~/code/my-project" autoCapitalize="off" autoCorrect="off" spellcheck={false} onInput={(e) => setPath((e.target as HTMLInputElement).value)} />
      </label>
      <div class="s-row2">
        <label class="s-field">
          <span>Id</span>
          <input class="s-input mono" value={id} placeholder={guess === '' ? 'my-project' : guess} autoCapitalize="off" autoCorrect="off" spellcheck={false} onInput={(e) => setId((e.target as HTMLInputElement).value)} />
        </label>
        <label class="s-field">
          <span>Name</span>
          <input class="s-input" value={name} maxLength={NAME_MAX} placeholder="Optional" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      <ColorPicker value={color} onPick={setColor} />
      <p class="dim-3 s-hint">The id comes from the folder's real name unless you type one. Adding asks for your approval on your phone.</p>
      <button type="submit" class="btn primary" disabled={busy || path.trim() === ''}>
        <Icon name="plus" size={16} />
        Add project
      </button>
    </form>
  )
}

export function AddSharedForm({ busy, onSubmit }: { readonly busy: boolean; readonly onSubmit: (path: string) => void }) {
  const [path, setPath] = useState('')
  return (
    <form
      class="s-form s-form-inline"
      onSubmit={(event) => {
        event.preventDefault()
        if (path.trim() !== '' && !busy) onSubmit(path.trim())
      }}
    >
      <input class="s-input mono" aria-label="Shared folder" value={path} placeholder="~/Notes" autoCapitalize="off" autoCorrect="off" spellcheck={false} onInput={(e) => setPath((e.target as HTMLInputElement).value)} />
      <button type="submit" class="btn" disabled={busy || path.trim() === ''}>
        Share
      </button>
    </form>
  )
}

export function EditProjectSheet({
  id,
  name,
  color,
  busy,
  error,
  onSave,
  onClose,
}: {
  readonly id: string
  readonly name: string | undefined
  readonly color: Color | undefined
  readonly busy: boolean
  readonly error: string | undefined
  readonly onSave: (name: string | undefined, color: Color | undefined) => void
  readonly onClose: () => void
}) {
  const [draft, setDraft] = useState(name ?? '')
  const [tone, setTone] = useState<Color | undefined>(color)
  return (
    <Sheet id="s-edit-title" title={`Edit ${name ?? id}`} onClose={onClose}>
      <label class="s-field">
        <span>Name</span>
        <input class="s-input" value={draft} maxLength={NAME_MAX} placeholder={id} onInput={(e) => setDraft((e.target as HTMLInputElement).value)} />
      </label>
      <ColorPicker value={tone} onPick={setTone} />
      {error === undefined ? null : <p class="s-error" role="alert">{error}</p>}
      <div class="s-choice">
        <button type="button" class="btn decide" onClick={onClose}>
          Cancel
        </button>
        <button type="button" class="btn decide primary" disabled={busy} onClick={() => onSave(draft.trim() === '' ? undefined : draft.trim(), tone)}>
          Save
        </button>
      </div>
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
        <input class="s-input mono" value={typed} autoCapitalize="off" autoCorrect="off" spellcheck={false} onInput={(e) => setTyped((e.target as HTMLInputElement).value)} />
      </label>
      {error === undefined ? null : <p class="s-error" role="alert">{error}</p>}
      <div class="s-choice">
        <button type="button" class="btn decide" onClick={onClose}>
          Cancel
        </button>
        <button type="button" class="btn decide danger" disabled={busy || typed !== label} onClick={onDelete}>
          Delete
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
      <div class="s-choice">
        <button type="button" class="btn decide" onClick={onClose}>
          Cancel
        </button>
        <button type="button" class="btn decide danger" disabled={busy} onClick={onConfirm}>
          {action}
        </button>
      </div>
    </Sheet>
  )
}
