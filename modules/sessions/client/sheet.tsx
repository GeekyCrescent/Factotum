/**
 * A sheet that asks for one decision: its title takes focus, Escape and the scrim close it, and
 * focus goes back where it was (spec 2026-09-29, D10, D11). The shell's `.sheet` and `.scrim`,
 * shared by name: this module imports nothing from the shell.
 */

import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

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
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    heading.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      before?.focus()
    }
  }, [onClose])
  return (
    <>
      <div class="scrim" onClick={onClose} />
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby={id}>
        <div class="grab" />
        <h2 id={id} ref={heading} tabIndex={-1}>
          {title}
        </h2>
        {children}
      </div>
    </>
  )
}
