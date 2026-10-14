/**
 * A sheet: its title (or a field marked `autofocus`) takes focus, Escape and the scrim close it, and
 * focus goes back where it was. The shell's `.sheet` and `.scrim`, shared by name — the pattern of the
 * sessions module's sheet, written again here because a module imports nothing from another.
 */

import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { Icon } from './icon.tsx'

export function Sheet({
  id,
  title,
  onClose,
  children,
}: {
  readonly id: string
  readonly title: string
  readonly onClose: () => void
  readonly children: ComponentChildren
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
  return (
    <>
      <div class="scrim" onClick={onClose} />
      <div class="sheet t-sheet" role="dialog" aria-modal="true" aria-labelledby={id}>
        <div class="grab" />
        <div class="t-sheet-head">
          <h2 id={id} ref={heading} tabIndex={-1}>
            {title}
          </h2>
          <button type="button" class="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>
        {children}
      </div>
    </>
  )
}
