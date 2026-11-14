/**
 * A sheet: its title (or a field marked `autofocus`) takes focus, Escape and the scrim close it, Tab
 * goes round its own controls and never reaches the review behind (`focus-trap.ts`), and focus goes
 * back where it was. While it is open, the review's keys stand aside (`isDialogOpen`). The shell's `.sheet` and `.scrim`, shared by name — the pattern of
 * the tasks module's sheet, written again here because a module imports nothing from another.
 */

import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { trappedFocus } from './focus-trap.ts'
import { ICONS, type JobsIcon } from './icons.ts'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Tab inside `sheet`: round its controls. */
function trapTab(event: KeyboardEvent, sheet: Element): void {
  const controls = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)]
  const next = trappedFocus(controls.indexOf(document.activeElement as HTMLElement), controls.length, event.shiftKey)
  if (next === null) return
  event.preventDefault()
  controls[next]?.focus()
}

export function Icon({ name, size = 18 }: { readonly name: JobsIcon; readonly size?: number }) {
  return (
    <svg class="icon" viewBox="0 0 256 256" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  )
}

export interface SheetProps {
  readonly id: string
  readonly title: ComponentChildren
  readonly onClose: () => void
  readonly children: ComponentChildren
}

export function Sheet({ id, title, onClose, children }: SheetProps) {
  const heading = useRef<HTMLHeadingElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const field = heading.current?.closest('.sheet')?.querySelector<HTMLElement>('[autofocus]')
    ;(field ?? heading.current)?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return
      const sheets = document.querySelectorAll('.sheet')
      const mine = heading.current?.closest('.sheet')
      if (mine === null || mine === undefined || sheets[sheets.length - 1] !== mine) return
      if (event.key === 'Tab') trapTab(event, mine)
      else close.current()
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
      <div class="sheet j-sheet" role="dialog" aria-modal="true" aria-labelledby={id}>
        <div class="grab" />
        <div class="j-sheet-head">
          <h2 id={id} ref={heading} tabIndex={-1}>
            {title}
          </h2>
          <button type="button" class="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </>
  )
}

/** A sheet or a dialog is open: the review's keys stand aside. */
export const isDialogOpen = (): boolean => document.querySelector('.sheet, [role="dialog"]') !== null
