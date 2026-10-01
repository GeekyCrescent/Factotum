/**
 * The list `@` opens above the box (spec 2026-10-01-referencias-y-tab, D8): the folder the token
 * points at, Tab to complete and go in, arrows and Enter on a computer, a tap on a phone.
 *
 * THE `@` IS READ FROM THE TEXT AND THE CARET, never from the `keydown` of the `@`: on Android the
 * keyboard sends `key: 'Unidentified'` while it composes a word. `sync` runs on input, click, keyup
 * and focus, and everything else is derived from the text and where the caret is.
 *
 * THE KEYS ARE THE LIST'S ONLY WHILE IT IS OPEN. Closed — or with no row to choose — Tab and Enter do
 * what they always did. The box's text is the only state there is: nothing about a reference is kept
 * anywhere else.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { RefObject } from 'preact'
import type { Listing, ListingEntry } from '../types.ts'
import type { Api } from './contract.ts'
import { Icon } from './icon.tsx'
import {
  latest,
  pickerErrorText,
  refText,
  requestOf,
  tabOf,
  tokenAt,
  tokenText,
  type FilesState,
  type RefTarget,
  type Token,
} from './refs.ts'

/** How long the box waits after a key before it asks the daemon: a filter, not a request per key. */
const ASK_AFTER_MS = 120

type RowKind = 'up' | 'this' | 'dir' | 'shared' | 'file'

interface Row {
  readonly key: string
  readonly kind: RowKind
  readonly label: string
  /** For `this`, `file`: what is inserted. `undefined`: the name cannot be referenced. */
  readonly insert: string | undefined
  /** For `up`, `dir`, `shared`: the query the token becomes. */
  readonly goTo: string | undefined
}

type PickerView =
  | { readonly kind: 'closed' }
  /** A folder asked for and not here yet: nothing to show, and Tab and Enter wait for it. */
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'rows'; readonly rows: readonly Row[]; readonly selected: number; readonly more: number; readonly partial: boolean }

export interface PickerControls {
  readonly textarea: RefObject<HTMLTextAreaElement>
  /** On input, click, keyup and focus: reads the caret again. */
  readonly sync: () => void
  /** First thing the box's onKeyDown asks. `true`: the key was the list's. */
  readonly onKey: (event: KeyboardEvent) => boolean
  readonly view: PickerView
  readonly choose: (row: number) => void
  readonly listId: string
  readonly optionId: (row: number) => string
}

let instances = 0

export function usePicker(input: {
  readonly api: Api
  /** The project the box would run in, and its folder. `undefined`: no project, the list stays shut. */
  readonly site: { readonly id: string; readonly path: string } | undefined
  readonly capability: FilesState
  readonly text: string
  readonly setText: (text: string) => void
}): PickerControls {
  const { api, site, capability, text, setText } = input
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState(0)
  /**
   * WHAT CAME BACK, AND FOR WHICH FOLDER. A listing only counts for the folder (and project) it
   * answers: while another is on its way — a folder just entered, another project chosen — the list is
   * shut and the keys are the box's, never the old folder's rows under the new query. Within the same
   * folder it stays, narrowed here by what was typed since, so filtering does not flicker.
   */
  const [answer, setAnswer] = useState<{ readonly key: string; readonly folder: string; readonly listing?: Listing; readonly error?: string } | undefined>(undefined)
  const [selected, setSelected] = useState(-1)
  const [dismissed, setDismissed] = useState<string | undefined>(undefined)
  const order = useRef(latest())
  const pendingCaret = useRef<number | undefined>(undefined)
  const listId = useMemo(() => `s-picker-${(instances += 1)}`, [])

  const token: Token | undefined = useMemo(
    () => (capability.kind === 'on' && site !== undefined ? tokenAt(text, Math.min(caret, text.length)) : undefined),
    [capability.kind, site, text, caret],
  )
  const request = token === undefined || site === undefined ? undefined : requestOf(token.query, site.path)
  const tokenKey = token === undefined ? undefined : `${site?.id ?? ''}\u0000${token.start}\u0000${token.query}`
  const open = request !== undefined && tokenKey !== dismissed

  // Ask the daemon for the folder the token points at, a moment after the last key.
  const folderKey = request === undefined || site === undefined ? undefined : `${site.id}\u0000${request.dir ?? ''}`
  const requestKey = folderKey === undefined || request === undefined ? undefined : `${folderKey}\u0000${request.prefix}`
  useEffect(() => {
    if (!open || request === undefined || site === undefined || requestKey === undefined) return
    const key = requestKey
    const folder = folderKey as string
    const n = order.current.next()
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ site: site.id })
      if (request.dir !== undefined) query.set('dir', request.dir)
      if (request.prefix !== '') query.set('prefix', request.prefix)
      api.get<Listing>(`files?${query.toString()}`).then(
        (got) => {
          if (!order.current.isLatest(n)) return
          setAnswer({ key, folder, listing: got })
          setSelected(-1)
        },
        (cause: unknown) => {
          if (order.current.isLatest(n)) setAnswer({ key, folder, error: pickerErrorText(cause) })
        },
      )
    }, ASK_AFTER_MS)
    // Closing, a new request or the box going away: whatever is still on its way no longer counts.
    return () => {
      clearTimeout(timer)
      order.current.next()
    }
    // Keyed by the request's own text: a new token object with the same query asks nothing new.
  }, [open, requestKey])

  const typedNow = request?.prefix ?? ''
  const listing = answer?.listing !== undefined && answer.folder === folderKey ? narrowed(answer.listing, typedNow) : undefined
  const error = answer?.key === requestKey ? answer?.error : undefined

  // A caret the list moved lands after the render that put the new text in place.
  useEffect(() => {
    const at = pendingCaret.current
    const element = textarea.current
    if (at === undefined || element === null) return
    pendingCaret.current = undefined
    element.focus()
    element.setSelectionRange(at, at)
    setCaret(at)
  }, [text])

  const rows = useMemo(() => (listing === undefined || token === undefined ? [] : rowsOf(listing, token)), [listing, token])
  const choosable = rows.flatMap((row, i) => (row.insert !== undefined || row.goTo !== undefined ? [i] : []))
  // A filter that matches nothing closes the list and gives the keys back (design D7). An empty folder
  // just entered keeps «..» and «This folder».
  const typed = token === undefined ? '' : token.query.slice(folderOf(token.query).length)
  const empty = typed !== '' && rows.every((row) => row.kind === 'up' || row.kind === 'this')
  // By default the first NAME, not «..» or «This folder»: Enter after `@src/app` picks `app.ts`.
  const firstName = choosable.find((i) => rows[i]?.kind !== 'up' && rows[i]?.kind !== 'this')
  const current = choosable.includes(selected) ? selected : (firstName ?? choosable[0] ?? -1)

  const view: PickerView = !open
    ? { kind: 'closed' }
    : error !== undefined
      ? { kind: 'error', message: error }
      : listing === undefined
        ? { kind: 'loading' }
        : empty
          ? { kind: 'closed' }
        : { kind: 'rows', rows, selected: current, more: listing.more, partial: listing.partial }

  /** The token, replaced. Inserting closes it with a space; navigating keeps it open, caret at its end. */
  const replace = (replacement: string, closing: boolean) => {
    if (token === undefined) return
    // One space after an inserted reference, unless the text already has a blank there.
    const next = text[token.end]
    const written = closing && (next === undefined || !/\s/.test(next)) ? `${replacement} ` : replacement
    pendingCaret.current = token.start + written.length
    setText(text.slice(0, token.start) + written + text.slice(token.end))
  }

  const choose = (index: number) => {
    const row = rows[index]
    if (row === undefined || token === undefined) return
    if (row.goTo !== undefined) return replace(tokenText(row.goTo, token.quoted), false)
    if (row.insert !== undefined) replace(row.insert, true)
  }

  const tab = () => {
    if (listing === undefined || token === undefined) return
    const done = tabOf(listing, token.query)
    if (done === undefined) return
    if (done.kind === 'insert') return replace(done.text, true)
    replace(tokenText(done.query, token.quoted), false)
  }

  const onKey = (event: KeyboardEvent): boolean => {
    // `isComposing` is false in Safari on the keydown that commits a word; 229 is that key.
    if (view.kind === 'closed' || event.isComposing || event.keyCode === 229) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      setDismissed(tokenKey)
      return true
    }
    // Right after going into a folder, before its names arrive: Tab must not leave the box and Enter
    // must not send a message whose reference is half written.
    if (view.kind === 'loading' && ((event.key === 'Tab' && !event.shiftKey) || (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey))) {
      event.preventDefault()
      return true
    }
    if (view.kind !== 'rows') return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const at = choosable.indexOf(current)
      const next = event.key === 'ArrowDown' ? Math.min(choosable.length - 1, at + 1) : Math.max(0, at - 1)
      setSelected(choosable[next] ?? current)
      return true
    }
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault()
      tab()
      return true
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && current >= 0) {
      event.preventDefault()
      choose(current)
      return true
    }
    return false
  }

  const sync = () => {
    const element = textarea.current
    if (element !== null) setCaret(element.selectionStart)
  }

  return { textarea, sync, onKey, view, choose, listId, optionId: (row) => `${listId}-${row}` }
}

/** A folder's listing, narrowed to what was typed after it was asked for. */
function narrowed(listing: Listing, typed: string): Listing {
  const want = typed.normalize('NFC').toLowerCase()
  const keep = (name: string) => name.normalize('NFC').toLowerCase().startsWith(want)
  return { ...listing, entries: listing.entries.filter((item) => keep(item.name)), shared: listing.shared.filter((item) => keep(item.name)) }
}

/** The query up to and including its last `/`: the folder part. */
function folderOf(query: string): string {
  return query.slice(0, query.lastIndexOf('/') + 1)
}

/** The rows of a folder: «..» and «This folder» below the top, folders, shared folders, then files. */
function rowsOf(listing: Listing, token: Token): readonly Row[] {
  const folder = folderOf(token.query)
  const rows: Row[] = []
  if (folder !== '') {
    rows.push({ key: 'up', kind: 'up', label: '..', insert: undefined, goTo: parentOf(folder, listing) })
    rows.push({ key: 'this', kind: 'this', label: 'This folder', insert: refText(listing, { kind: 'this-dir' }), goTo: undefined })
  }
  const entry = (item: ListingEntry): Row =>
    item.kind === 'dir'
      ? { key: `d:${item.name}`, kind: 'dir', label: item.name, insert: undefined, goTo: `${folder}${item.name}/` }
      : { key: `f:${item.name}`, kind: 'file', label: item.name, insert: refText(listing, item), goTo: undefined }
  rows.push(...listing.entries.filter((item) => item.kind === 'dir').map(entry))
  rows.push(
    ...listing.shared.map((shared): Row => ({ key: `s:${shared.path}`, kind: 'shared', label: shared.name, insert: undefined, goTo: `${shared.path}/` })),
  )
  rows.push(...listing.entries.filter((item) => item.kind === 'file').map(entry))
  return rows
}

/** Where «..» goes: one folder up, and from the top of a shared folder, back to the project's. */
function parentOf(folder: string, listing: Listing): string {
  const trimmed = folder.slice(0, -1)
  if (listing.root.kind === 'shared' && trimmed === listing.root.path) return ''
  const cut = trimmed.lastIndexOf('/')
  return cut <= 0 ? '' : trimmed.slice(0, cut + 1)
}

const ICON: Readonly<Record<RowKind, 'arrow-up' | 'folder-open' | 'folder-simple' | 'stack' | 'file-text'>> = {
  up: 'arrow-up',
  this: 'folder-open',
  dir: 'folder-simple',
  shared: 'stack',
  file: 'file-text',
}

export function FilePicker({ picker }: { readonly picker: PickerControls }) {
  const { view } = picker
  if (view.kind === 'closed' || view.kind === 'loading') return null
  if (view.kind === 'error') {
    return (
      <p class="s-picker-note" role="status">
        <Icon name="warning" size={16} />
        {view.message}
      </p>
    )
  }
  return (
    <div class="s-picker">
      <ul id={picker.listId} class="s-picker-list" role="listbox" aria-label="Project files">
        {view.rows.map((row, i) => {
          const off = row.insert === undefined && row.goTo === undefined
          return (
            <li
              key={row.key}
              id={picker.optionId(i)}
              role="option"
              aria-selected={i === view.selected}
              aria-disabled={off}
              class={`s-picker-row${i === view.selected ? ' s-picker-on' : ''}${off ? ' s-picker-off' : ''}`}
              title={off ? 'This name cannot be referenced' : undefined}
              // Keeps the focus in the box, so the phone's keyboard stays up. The choice is made on
              // click, which a finger that scrolled never fires.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                if (!off) picker.choose(i)
              }}
            >
              <Icon name={ICON[row.kind]} size={16} />
              <span class="s-picker-name">{row.label}</span>
              {row.kind === 'dir' || row.kind === 'shared' ? <span class="s-picker-hint">/</span> : null}
              {off ? <span class="s-picker-hint">This name cannot be referenced</span> : null}
            </li>
          )
        })}
      </ul>
      {view.more > 0 ? <p class="s-picker-more">{view.more} more. Keep typing to narrow.</p> : null}
      {view.partial ? <p class="s-picker-more">This folder is too large to list whole</p> : null}
    </div>
  )
}
