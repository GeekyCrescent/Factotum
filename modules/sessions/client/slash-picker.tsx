/**
 * The list `/` opens above the box (spec 2026-10-03-skills-a-mano, D8): the skills, commands and agents
 * the CLI announced, ordered by the owner's note, with this project's pins first.
 *
 * The same shape as `picker.tsx`: THE `/` IS READ FROM THE TEXT AND THE CARET, never from a key (Android
 * sends `key: 'Unidentified'` while it composes), and THE KEYS ARE THE LIST'S ONLY WHILE IT IS OPEN.
 * Closed, or with no row to choose, Tab and Enter do what they always did.
 *
 * PINNING is a long press on a phone and a right-click on a computer, with the `useLongPress` the drawer
 * uses. It is a hook with refs, so every entry row is its own component and calls it: never in a `.map`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { RefObject } from 'preact'
import { PINNED_LABEL, type SkillEntryView, type SkillsView } from '../skills/arrange.ts'
import { ContextMenu, useLongPress, type MenuAt } from './context-menu.tsx'
import type { Api } from './contract.ts'
import { messageOf } from './errors.ts'
import { latest } from './refs.ts'
import { applyInsertion, insertionFor, rowText, slashRows, slashTokenAt, type SlashRow } from './slash.ts'

/** What shows when the CLI has announced nothing yet (criterion 3). */
const UNKNOWN_TEXT = 'The list appears after your first conversation'

type SlashViewState =
  | { readonly kind: 'closed' }
  /** The project's list asked for and not here yet: nothing to show, and Tab and Enter wait for it. */
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'rows'; readonly rows: readonly SlashRow[]; readonly selected: number }

export interface SlashControls {
  /** On input, click, keyup and focus: reads the caret again. */
  readonly sync: () => void
  /** The box asks this before the `@` list on every key. `true`: the key was the list's. */
  readonly onKey: (event: KeyboardEvent) => boolean
  readonly view: SlashViewState
  readonly choose: (row: number) => void
  readonly listId: string
  readonly optionId: (row: number) => string
  /** Names pinned in this project. */
  readonly pinned: ReadonlySet<string>
  /** `undefined`: no project, so no pinning. */
  readonly projectLabel: string | undefined
  readonly menu: { readonly entry: SkillEntryView; readonly at: MenuAt } | undefined
  readonly openMenu: (entry: SkillEntryView, at: MenuAt) => void
  readonly closeMenu: () => void
  readonly togglePin: (entry: SkillEntryView) => void
  /** A pin that did not go through, in one line. */
  readonly notice: string | undefined
}

let instances = 0

const keyOfEntry = (entry: SkillEntryView): string => `${entry.kind}:${entry.name}`

export function useSlash(input: {
  readonly api: Api
  readonly siteId: string | undefined
  /** Shown in the pin menu: «Pin to <project>». */
  readonly projectLabel?: string | undefined
  readonly mode: 'launch' | 'reply'
  readonly text: string
  readonly setText: (text: string) => void
  /** The same ref `usePicker` hands out: one textarea, one caret. */
  readonly textarea: RefObject<HTMLTextAreaElement>
  /** Only in launch: the chip carries the agent. */
  readonly onAgent?: ((name: string) => void) | undefined
}): SlashControls {
  const { api, siteId, projectLabel, mode, text, setText, textarea, onAgent } = input
  const [caret, setCaret] = useState(0)
  /** The list a project answered, kept while the box lives; re-asked after a pin. A late one for another project is dropped. */
  const [answer, setAnswer] = useState<{ readonly key: string; readonly view?: SkillsView; readonly error?: string } | undefined>(undefined)
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined)
  const [dismissed, setDismissed] = useState<string | undefined>(undefined)
  const [menu, setMenu] = useState<SlashControls['menu']>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [landing, setLanding] = useState<{ readonly caret: number } | undefined>(undefined)
  const order = useRef(latest())
  const listId = useMemo(() => `s-slash-${(instances += 1)}`, [])

  const siteKey = siteId ?? ''
  const token = useMemo(() => slashTokenAt(text, Math.min(caret, text.length)), [text, caret])
  const tokenKey = token === undefined ? undefined : `${siteKey}\u0000${token.query}`
  const open = token !== undefined && tokenKey !== dismissed

  const load = useCallback(() => {
    const n = order.current.next()
    const query = siteId === undefined ? '' : `?site=${encodeURIComponent(siteId)}`
    api.get<SkillsView>(`skills${query}`).then(
      (view) => {
        if (order.current.isLatest(n)) setAnswer({ key: siteKey, view })
      },
      (cause: unknown) => {
        if (order.current.isLatest(n)) setAnswer({ key: siteKey, error: messageOf(cause) })
      },
    )
  }, [api, siteId, siteKey])

  // A selection belongs to one opening of the list: a fresh `/` starts at the top, never on a row that
  // was chosen earlier and is out of sight. Narrowing inside the same token keeps it (`open` stays true).
  useEffect(() => {
    if (!open) setSelectedKey(undefined)
  }, [open])

  // The first time it opens with this project. Closing or another project: what is on its way no longer counts.
  useEffect(() => {
    if (!open || (answer?.key === siteKey && answer.view !== undefined)) return
    load()
    return () => {
      order.current.next()
    }
  }, [open, siteKey])

  // A caret the list moved lands after the render that put the new text in place.
  useEffect(() => {
    if (landing === undefined) return
    const element = textarea.current
    if (element === null) return
    element.focus()
    element.setSelectionRange(landing.caret, landing.caret)
    setCaret(landing.caret)
    setLanding(undefined)
  }, [text, landing])

  const view = answer?.key === siteKey ? answer.view : undefined
  const rows = useMemo(() => (view === undefined || token === undefined ? [] : slashRows(view, token.query)), [view, token])
  const choosable = rows.flatMap((row, i) => (row.kind === 'entry' ? [i] : []))
  // The row chosen by name, so it survives the list narrowing; by default the first entry.
  const chosen = choosable.find((i) => {
    const row = rows[i]
    return row?.kind === 'entry' && keyOfEntry(row.entry) === selectedKey
  })
  const current = chosen ?? choosable[0] ?? -1

  const pinned = useMemo(
    () => new Set(view?.groups.find((group) => group.label === PINNED_LABEL)?.entries.map((entry) => entry.name) ?? []),
    [view],
  )

  const state: SlashViewState = !open
    ? { kind: 'closed' }
    : answer?.key === siteKey && answer.error !== undefined && view === undefined
      ? { kind: 'error', message: answer.error }
      : view === undefined
        ? { kind: 'loading' }
        : view.list.state === 'unknown'
          ? { kind: 'unknown' }
          // No row, with a query or without one: the list shuts and the keys go back to the box.
          : choosable.length === 0
            ? { kind: 'closed' }
            : { kind: 'rows', rows, selected: current }

  const choose = (index: number) => {
    const row = rows[index]
    if (row === undefined || row.kind !== 'entry' || token === undefined) return
    const insertion = insertionFor(row.entry, mode)
    if (insertion.kind === 'agent') onAgent?.(insertion.name)
    const next = applyInsertion(text, token.end, insertion)
    setSelectedKey(undefined)
    setLanding({ caret: next.caret })
    setText(next.text)
  }

  const onKey = (event: KeyboardEvent): boolean => {
    // `isComposing` is false in Safari on the keydown that commits a word; 229 is that key.
    if (state.kind === 'closed' || event.isComposing || event.keyCode === 229) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      setDismissed(tokenKey)
      return true
    }
    const plainEnter = event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey
    const plainTab = event.key === 'Tab' && !event.shiftKey
    // Before the list arrives: Tab must not leave the box and Enter must not send a half-written `/`.
    if (state.kind === 'loading' && (plainTab || plainEnter)) {
      event.preventDefault()
      return true
    }
    if (state.kind !== 'rows') return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const at = choosable.indexOf(current)
      const next = event.key === 'ArrowDown' ? Math.min(choosable.length - 1, at + 1) : Math.max(0, at - 1)
      const row = rows[choosable[next] ?? current]
      if (row?.kind === 'entry') setSelectedKey(keyOfEntry(row.entry))
      return true
    }
    if ((plainTab || plainEnter) && current >= 0) {
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

  const closeMenu = useCallback(() => {
    setMenu(undefined)
    textarea.current?.focus()
  }, [textarea])

  const togglePin = (entry: SkillEntryView) => {
    if (siteId === undefined) return
    setNotice(undefined)
    api.post(`projects/${encodeURIComponent(siteId)}/pins`, { name: entry.name, pinned: !pinned.has(entry.name) }).then(
      () => load(),
      (cause: unknown) => setNotice((cause as { status?: unknown } | null)?.status === 409 ? 'A project holds at most 12 pins.' : `Could not pin: ${messageOf(cause)}`),
    )
  }

  return {
    sync,
    onKey,
    view: state,
    choose,
    listId,
    optionId: (row) => `${listId}-${row}`,
    pinned,
    projectLabel: siteId === undefined ? undefined : projectLabel,
    menu,
    openMenu: (entry, at) => setMenu({ entry, at }),
    closeMenu,
    togglePin,
    notice,
  }
}

export function SlashPicker({ slash }: { readonly slash: SlashControls }) {
  const { view, menu } = slash
  return (
    <>
      {view.kind === 'unknown' ? (
        <p class="s-picker-note s-slash-note" role="status">
          {UNKNOWN_TEXT}
        </p>
      ) : null}
      {view.kind === 'error' ? (
        <p class="s-picker-note" role="status">
          {view.message}
        </p>
      ) : null}
      {view.kind === 'rows' ? <SlashList slash={slash} rows={view.rows} selected={view.selected} /> : null}
      {menu === undefined || slash.projectLabel === undefined ? null : (
        <ContextMenu at={menu.at} onClose={slash.closeMenu}>
          <button type="button" role="menuitem" class="s-ctx-item" onClick={() => slash.togglePin(menu.entry)}>
            {slash.pinned.has(menu.entry.name) ? `Unpin from ${slash.projectLabel}` : `Pin to ${slash.projectLabel}`}
          </button>
        </ContextMenu>
      )}
    </>
  )
}

function SlashList({ slash, rows, selected }: { readonly slash: SlashControls; readonly rows: readonly SlashRow[]; readonly selected: number }) {
  const canPin = slash.projectLabel !== undefined
  return (
    <div class="s-picker">
      <ul id={slash.listId} class="s-picker-list" role="listbox" aria-label="Skills, commands and agents">
        {rows.map((row, i) =>
          row.kind === 'group' ? (
            <li key={`g:${row.label}`} role="presentation" class="s-slash-group">
              {row.label}
            </li>
          ) : (
            <SlashEntryRow
              key={keyOfEntry(row.entry)}
              id={slash.optionId(i)}
              entry={row.entry}
              selected={i === selected}
              onChoose={() => slash.choose(i)}
              onMenu={canPin ? (at) => slash.openMenu(row.entry, at) : undefined}
            />
          ),
        )}
      </ul>
      {slash.notice === undefined ? null : (
        <p class="s-picker-more s-slash-notice" role="status">
          {slash.notice}
        </p>
      )}
      {canPin ? <p class="s-picker-more s-slash-hint">{window.matchMedia('(pointer: coarse)').matches ? 'Long-press to pin' : 'Right-click to pin'}</p> : null}
    </div>
  )
}

/** One entry. Its own component because `useLongPress` keeps refs: one per row, never inside a `.map`. */
function SlashEntryRow({
  id,
  entry,
  selected,
  onChoose,
  onMenu,
}: {
  readonly id: string
  readonly entry: SkillEntryView
  readonly selected: boolean
  readonly onChoose: () => void
  /** `undefined`: no project, nothing to pin to. */
  readonly onMenu: ((at: MenuAt) => void) | undefined
}) {
  const press = useLongPress((at) => onMenu?.(at))
  const text = rowText(entry)
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      class={`s-picker-row s-slash-row${selected ? ' s-picker-on' : ''}`}
      onContextMenu={onMenu === undefined ? undefined : press.onContextMenu}
      // Keeps the focus in the box, so the phone's keyboard stays up; then the long press's own timer.
      onPointerDown={(event) => {
        event.preventDefault()
        press.onPointerDown(event)
      }}
      onPointerMove={press.onPointerMove}
      onPointerUp={press.onPointerUp}
      onPointerCancel={press.onPointerCancel}
      // The choice is made on click, which a finger that scrolled never fires; the click that ends a
      // long press is the menu's, not a choice.
      onClick={() => {
        if (press.swallow()) return
        onChoose()
      }}
    >
      <span class="s-slash-head">
        <span class="s-slash-name">{entry.name}</span>
        {entry.kind === 'skill' ? null : <span class="s-slash-kind">{entry.kind}</span>}
      </span>
      {text === undefined ? null : <span class="s-slash-text">{text}</span>}
    </li>
  )
}
