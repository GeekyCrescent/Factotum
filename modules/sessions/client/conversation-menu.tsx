/**
 * The conversation's `⋯`: Rename, Archive or Unarchive, Delete (spec 2026-09-29, D11). All three
 * are off while it runs: the daemon refuses archiving and deleting a running one anyway (409), and
 * a menu that offers what will be refused is a menu that lies.
 *
 * Deleting asks once, in a sheet, and lands on "New session": the conversation is gone.
 */

import { useState } from 'preact/hooks'
import type { SessionSummary } from '../types.ts'
import type { Api } from './contract.ts'
import { messageOf } from './errors.ts'
import { nameOf, renameAction } from './history.ts'
import { Icon } from './icon.tsx'
import { ConfirmSheet } from './project-forms.tsx'
import { Sheet } from './sheet.tsx'

/** A title is cut at this length by the daemon (criterion 30); the field says so by stopping there. */
const TITLE_MAX = 80

type Open = 'menu' | 'rename' | 'delete'

export function ConversationMenu({
  api,
  summary,
  projectLabel,
  running,
  onChanged,
  onDeleted,
}: {
  readonly api: Api
  readonly summary: SessionSummary
  readonly projectLabel: string | undefined
  readonly running: boolean
  readonly onChanged: () => void
  readonly onDeleted: () => void
}) {
  const [open, setOpen] = useState<Open | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const close = () => {
    setOpen(undefined)
    setError(undefined)
  }

  const act = async (work: () => Promise<unknown>, after: () => void) => {
    setBusy(true)
    setError(undefined)
    try {
      await work()
      setOpen(undefined)
      after()
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" class="icon-btn" aria-label="Conversation options" aria-haspopup="dialog" disabled={running} onClick={() => setOpen('menu')}>
        <Icon name="dots-three" />
      </button>
      {open === 'menu' ? (
        <Sheet id="s-conv-menu" title={nameOf(summary)} onClose={close}>
          <div class="s-menu">
            <button type="button" class="s-menu-item" onClick={() => setOpen('rename')}>
              <Icon name="pencil-simple" size={18} />
              Rename
            </button>
            <button
              type="button"
              class="s-menu-item"
              disabled={busy}
              onClick={() => void act(() => api.post(`sessions/${summary.id}/archive`, { archived: !summary.archived }), onChanged)}
            >
              <Icon name="archive" size={18} />
              {summary.archived ? 'Unarchive' : 'Archive'}
            </button>
            <button type="button" class="s-menu-item s-danger" onClick={() => setOpen('delete')}>
              <Icon name="trash" size={18} />
              Delete
            </button>
          </div>
          {error === undefined ? null : <p class="s-error" role="alert">{error}</p>}
        </Sheet>
      ) : null}
      {open === 'rename' || open === 'delete' ? (
        <ConversationSheet
          api={api}
          target={{ id: summary.id, title: summary.title ?? nameOf(summary), project: projectLabel, manualTitle: summary.title }}
          kind={open}
          onClose={close}
          onDone={open === 'delete' ? onDeleted : onChanged}
        />
      ) : null}
    </>
  )
}

/** The conversation a sheet acts on: its id and the title the rename field starts with. */
export interface SheetTarget {
  readonly id: string
  readonly title: string
  /** Whose conversation it is, said under the dialog's title. */
  readonly project?: string | undefined
  /**
   * The OWNER'S title, apart from what shows (spec 2026-09-30, D12). REQUIRED, so both ways in — the
   * `⋯` and the drawer's context menu — have to say: it is what lets an empty field clear it.
   */
  readonly manualTitle: string | undefined
}

/**
 * Renaming or deleting one conversation, as a sheet: from its own `⋯` and from the drawer's
 * context menu alike, so both say and do the same thing.
 */
export function ConversationSheet({
  api,
  target,
  kind,
  onClose,
  onDone,
}: {
  readonly api: Api
  readonly target: SheetTarget
  readonly kind: 'rename' | 'delete'
  readonly onClose: () => void
  readonly onDone: () => void
}) {
  const [title, setTitle] = useState(target.title)
  // Save a change, clear the owner's title, or nothing: what it already said is nothing to save, so
  // opening and saving never turns the titler's title into the owner's (spec 2026-09-30, D12).
  const action = renameAction(title, target.title, target.manualTitle)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await work()
      onClose()
      onDone()
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  if (kind === 'delete') {
    return (
      <ConfirmSheet
        title="Delete this conversation?"
        body="Its whole log is deleted for good. The files the agent changed stay as they are."
        action="Delete"
        busy={busy}
        error={error}
        onClose={onClose}
        onConfirm={() =>
          void act(async () => {
            // A result per id, and a 200 either way: "running" or "unknown" is not a deletion.
            const done = await api.post<{ results: readonly { outcome: string }[] }>('sessions/remove', { ids: [target.id] })
            const outcome = done.results[0]?.outcome
            if (outcome !== 'removed') throw new Error(outcome === 'running' ? 'It is running: cancel it first.' : 'It could not be deleted.')
          })
        }
      />
    )
  }
  return (
    <Sheet id="s-rename-title" title="Rename conversation" onClose={onClose}>
      <form
        class="s-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (action.kind === 'none') return
          // Empty clears the owner's title; the automatic one, or the first line, shows again.
          void act(() => api.post(`sessions/${target.id}/title`, { title: action.kind === 'save' ? action.title : '' }))
        }}
      >
        {target.project === undefined ? null : (
          <p class="s-dialog-context">
            <Icon name="folder-simple" size={14} />
            {target.project}
          </p>
        )}
        <label class="s-field">
          <span class="s-field-row">
            Title
            <span class={`num s-counter${title.length >= TITLE_MAX ? ' s-counter-full' : ''}`}>
              {title.length}/{TITLE_MAX}
            </span>
          </span>
          <input
            class="s-input"
            value={title}
            maxLength={TITLE_MAX}
            autoFocus
            // The whole title selected: typing replaces it, an arrow key keeps it.
            onFocus={(e) => (e.target as HTMLInputElement).select()}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          />
          <small>
            {target.manualTitle === undefined
              ? 'Shown in the drawer and at the top of the conversation.'
              : 'Shown in the drawer and at the top of the conversation. Leave it empty to use the automatic title.'}
          </small>
        </label>
        {error === undefined ? null : <p class="s-error" role="alert">{error}</p>}
        <div class="s-dialog-acts">
          <button type="button" class="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" class="btn primary" disabled={busy || action.kind === 'none'}>
            {busy ? 'Saving…' : action.kind === 'clear' ? 'Use automatic title' : 'Save'}
          </button>
        </div>
      </form>
    </Sheet>
  )
}
