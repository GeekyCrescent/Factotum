/**
 * The owner's categories in the drawer: a header that folds them, the grip that drags a project or a
 * category, and the sheets that name, move into and delete one.
 *
 * A CATEGORY IS ONLY A HEADING. Deleting one moves its projects to no category and deletes nothing
 * else; renaming it or moving things between them changes nothing an agent can use, so none of it
 * asks the phone (ADR-0011).
 */

import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import type { CategoryEntry } from '../types.ts'
import { useLongPress, type MenuAt } from './context-menu.tsx'
import { Icon } from './icon.tsx'
import { Sheet } from './sheet.tsx'

/** The daemon's ceiling for a category's name (`NAME_MAX` in `registry.ts`). */
const NAME_MAX = 40

/** How a header shows where a dragged thing will land. */
export type DropMark = 'before' | 'after' | 'into' | undefined

export function markClass(mark: DropMark): string {
  return mark === undefined ? '' : ` s-drop-${mark}`
}

/**
 * The handle a drag starts from, and the ONLY one: see `drag.ts`. A button, so the keyboard reaches
 * it: the arrow keys move what it holds one step, with no pointer at all.
 */
export function Grip({
  label,
  onStart,
  onStep,
}: {
  readonly label: string
  readonly onStart: (event: PointerEvent) => void
  readonly onStep: (delta: -1 | 1) => void
}) {
  return (
    <button
      type="button"
      class="s-grip"
      aria-label={`Move ${label}`}
      title="Drag to move · arrow keys move one step"
      onPointerDown={onStart}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        onStep(event.key === 'ArrowUp' ? -1 : 1)
      }}
    >
      <Icon name="dots-six-vertical" size={14} />
    </button>
  )
}

/**
 * One category: its header — a caret that folds it, its name, how many projects — and its projects
 * under it. The header is a drop target: dropping on it files the project last in the category, the
 * one way into a folded or empty one.
 */
export function CategoryBlock({
  category,
  count,
  folded,
  mark,
  dragged,
  canMove,
  onToggle,
  onMenu,
  onStart,
  onStep,
  children,
}: {
  readonly category: CategoryEntry
  readonly count: number
  readonly folded: boolean
  readonly mark: DropMark
  readonly dragged: boolean
  readonly canMove: boolean
  readonly onToggle: () => void
  readonly onMenu: (at: MenuAt) => void
  readonly onStart: (event: PointerEvent) => void
  readonly onStep: (delta: -1 | 1) => void
  readonly children: ComponentChildren
}) {
  const press = useLongPress(onMenu)
  return (
    <section class={`s-cat${dragged ? ' s-dragging' : ''}${mark === 'into' ? '' : markClass(mark)}`} data-category-block={category.id}>
      <div class={`s-cat-row${mark === 'into' ? ' s-drop-into' : ''}`} data-target="category" data-id={category.id}>
        <button
          type="button"
          class="s-cat-head"
          aria-expanded={!folded}
          onClick={() => {
            if (!press.swallow()) onToggle()
          }}
          onContextMenu={press.onContextMenu}
          onPointerDown={press.onPointerDown}
          onPointerMove={press.onPointerMove}
          onPointerUp={press.onPointerUp}
          onPointerCancel={press.onPointerCancel}
        >
          <Icon name={folded ? 'caret-right' : 'caret-down'} size={12} />
          <span class="s-cat-name">{category.name}</span>
          <span class="s-cat-count num">{count}</span>
        </button>
        {canMove ? <Grip label={category.name} onStart={onStart} onStep={onStep} /> : null}
      </div>
      {children}
    </section>
  )
}

/** Naming a category: a new one, or a new name for one. Empty is refused here and by the daemon. */
export function CategoryNameSheet({
  title,
  initial,
  action,
  onSave,
  onClose,
}: {
  readonly title: string
  readonly initial: string
  readonly action: string
  readonly onSave: (name: string) => void
  readonly onClose: () => void
}) {
  const [name, setName] = useState(initial)
  const wanted = name.trim()
  return (
    <Sheet id="s-category-name" title={title} onClose={onClose}>
      <form
        class="s-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (wanted === '') return
          onSave(wanted)
          onClose()
        }}
      >
        <label class="s-field">
          <span>Name</span>
          <input
            class="s-input"
            value={name}
            maxLength={NAME_MAX}
            placeholder="Work"
            autoFocus
            onFocus={(e) => (e.target as HTMLInputElement).select()}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
          <small>Only a heading in the drawer. Nothing about the projects in it changes.</small>
        </label>
        <div class="s-dialog-acts">
          <button type="button" class="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" class="btn primary" disabled={wanted === '' || wanted === initial}>
            {action}
          </button>
        </div>
      </form>
    </Sheet>
  )
}

/** Choosing a project's category: one of them, none, or a new one. */
export function MoveToCategorySheet({
  project,
  categories,
  current,
  onPick,
  onNew,
  onClose,
}: {
  readonly project: string
  readonly categories: readonly CategoryEntry[]
  readonly current: string | undefined
  readonly onPick: (category: string | undefined) => void
  readonly onNew: () => void
  readonly onClose: () => void
}) {
  const choose = (category: string | undefined) => {
    onPick(category)
    onClose()
  }
  const item = (category: string | undefined, label: string) => (
    <button type="button" key={category ?? ''} class="s-menu-item" aria-pressed={current === category} onClick={() => choose(category)}>
      <Icon name={current === category ? 'check' : 'folder-simple'} size={18} />
      {label}
    </button>
  )
  return (
    <Sheet id="s-move-category" title={`Move ${project} to…`} onClose={onClose}>
      <div class="s-menu">
        {categories.map((category) => item(category.id, category.name))}
        {item(undefined, 'No category')}
        <button type="button" class="s-menu-item" onClick={onNew}>
          <Icon name="folder-simple-plus" size={18} />
          New category…
        </button>
      </div>
    </Sheet>
  )
}
