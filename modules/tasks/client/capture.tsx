/**
 * Quick capture by hand (criterion 9): a title and Enter, straight to the column it was typed for —
 * Backlog or Todo, the only two the owner creates in. No AI: that capture, with the microphone, is the
 * second cut (E4, G3).
 *
 * TWO SHAPES (redesign A): on the desktop a field in the toolbar that `N` focuses from anywhere on the
 * board, and that a column's «+» points at its column; on the phone, fixed at the bottom of the screen.
 */

import type { RefObject } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { Icon } from './icon.tsx'

export type Target = 'backlog' | 'todo'

/** `N` focuses the capture, unless the key is being typed into something. */
export function useCaptureKey(input: RefObject<HTMLInputElement>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'n' && event.key !== 'N') return
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || event.defaultPrevented) return
      const at = event.target as HTMLElement | null
      if (at !== null && (at.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(at.tagName))) return
      // A sheet or any other dialog is open: the key belongs to it.
      if (document.querySelector('.sheet, [role="dialog"]') !== null) return
      event.preventDefault()
      input.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [input, enabled])
}

export function QuickCapture({
  target,
  label,
  add,
  sticky = false,
  input,
}: {
  readonly target: Target
  readonly label: string
  /** Resolves with whether the card was saved. */
  readonly add: (title: string, status: Target) => Promise<boolean>
  /** The phone's: fixed at the bottom of the screen. */
  readonly sticky?: boolean
  readonly input?: RefObject<HTMLInputElement>
}) {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (event: Event): Promise<void> => {
    event.preventDefault()
    const title = text.trim()
    if (title === '' || saving) return
    setSaving(true)
    // The text stays until the card is saved: a failure keeps what was typed.
    if (await add(title, target)) setText('')
    setSaving(false)
  }

  return (
    <form class={sticky ? 't-capture t-capture-sticky' : 't-capture t-capture-bar'} onSubmit={(event) => void submit(event)}>
      {sticky ? null : <Icon name="plus" size={16} class="t-capture-mark" />}
      <input
        {...(input === undefined ? {} : { ref: input })}
        class="t-capture-input"
        type="text"
        value={text}
        maxLength={200}
        placeholder={sticky ? `Add to ${label}` : `Add to ${label}, press N from anywhere`}
        aria-label={`New card in ${label}`}
        enterKeyHint="done"
        onInput={(event) => setText((event.target as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') (event.target as HTMLInputElement).blur()
        }}
      />
      <button type="submit" class="icon-btn" aria-label={`Add to ${label}`} disabled={text.trim() === '' || saving}>
        <Icon name="plus" size={18} />
      </button>
    </form>
  )
}
