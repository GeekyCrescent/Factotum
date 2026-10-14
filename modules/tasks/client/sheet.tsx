/**
 * A sheet: its title (or a field marked `autofocus`) takes focus, Escape and the scrim close it, and
 * focus goes back where it was. The shell's `.sheet` and `.scrim`, shared by name — the pattern of the
 * sessions module's sheet, written again here because a module imports nothing from another.
 *
 * REDESIGN A adds two things: a FOOT that stays at the bottom of the sheet while its body scrolls (the
 * card's Save, the close's «Close W42»), and two shapes of head — a title, or a small crumb above a
 * card whose own title is the first field.
 */

import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { Icon } from './icon.tsx'

export function Sheet({
  id,
  title,
  onClose,
  children,
  foot,
  crumb = false,
  wide = false,
}: {
  readonly id: string
  readonly title: ComponentChildren
  readonly onClose: () => void
  readonly children: ComponentChildren
  /** Stays in view at the bottom; nothing when absent. */
  readonly foot?: ComponentChildren
  /** The head is a small line of context, not the title. */
  readonly crumb?: boolean
  /** On a wide screen, a wider dialog: for a list with a choice on every row. */
  readonly wide?: boolean
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const field = heading.current?.closest('.sheet')?.querySelector<HTMLElement>('[autofocus]')
    ;(field ?? heading.current)?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      before?.focus()
    }
  }, [])
  const classes = ['sheet', 't-sheet', wide ? 't-sheet-wide' : '', foot === undefined ? '' : 't-sheet-footed']
  return (
    <>
      <div class="scrim" onClick={onClose} />
      <div class={classes.filter((c) => c !== '').join(' ')} role="dialog" aria-modal="true" aria-labelledby={id}>
        <div class="grab" />
        <div class={crumb ? 't-sheet-head t-sheet-crumb' : 't-sheet-head'}>
          <h2 id={id} ref={heading} tabIndex={-1}>
            {title}
          </h2>
          <button type="button" class="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>
        {children}
        {foot === undefined ? null : <div class="t-sheet-foot">{foot}</div>}
      </div>
    </>
  )
}
