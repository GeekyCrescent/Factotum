/**
 * Two captures in one field:
 * - BY HAND (criterion 9): a title and Enter, straight to the column it was typed for — Backlog or
 *   Todo, the only two the owner creates in. No AI.
 * - WITH AI (criteria 21–24): the ✦ button sends the text to `POST /capture`; the card lands in Triage at
 *   once and claude fills it in afterwards. The field then says so, until the next keystroke. The
 *   microphone joins it with the shared dictation (G3).
 *
 * TWO SHAPES (redesign A): on the desktop a field in the toolbar that `N` focuses from anywhere on the
 * board, and that a column's «+» points at its column; on the phone, fixed at the bottom of the screen.
 */

import type { RefObject } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Icon } from './icon.tsx'

/** A title typed by hand is at most this (`shape.ts`); a capture for claude can be longer. */
const MAX_TITLE_CHARS = 200
const MAX_CAPTURE_CHARS = 1000

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
  capture,
  sticky = false,
  input,
}: {
  readonly target: Target
  readonly label: string
  /** Resolves with whether the card was saved. */
  readonly add: (title: string, status: Target) => Promise<boolean>
  /** To Triage, read by claude. Resolves with whether the card was saved. */
  readonly capture?: (text: string) => Promise<boolean>
  /** The phone's: fixed at the bottom of the screen. */
  readonly sticky?: boolean
  readonly input?: RefObject<HTMLInputElement>
}) {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [sent, setSent] = useState(false)
  const own = useRef<HTMLInputElement>(null)
  const field = input ?? own
  const tooLong = text.trim().length > MAX_TITLE_CHARS

  /** The text stays until the card is saved: a failure keeps what was typed. */
  const send = async (save: (text: string) => Promise<boolean>, toTriage: boolean): Promise<void> => {
    const typed = text.trim()
    if (typed === '' || saving) return
    setSaving(true)
    if (await save(typed)) {
      setText('')
      setSent(toTriage)
    }
    setSaving(false)
  }
  const submit = (event: Event): void => {
    event.preventDefault()
    // Too long for a title: the note under the field says so, and the AI button is the way.
    if (tooLong) return
    void send((title) => add(title, target), false)
  }
  const placeholder = sent ? 'In Triage, claude is reading it. Add another' : sticky ? `Add to ${label}` : `Add to ${label}, press N from anywhere`

  return (
    <form class={sticky ? 't-capture t-capture-sticky' : 't-capture t-capture-bar'} onSubmit={submit}>
      {sticky ? null : <Icon name="plus" size={16} class="t-capture-mark" />}
      <input
        ref={field}
        class="t-capture-input"
        type="text"
        value={text}
        maxLength={capture === undefined ? MAX_TITLE_CHARS : MAX_CAPTURE_CHARS}
        aria-invalid={tooLong}
        {...(tooLong ? { 'aria-describedby': 't-capture-long' } : {})}
        placeholder={placeholder}
        aria-label={capture === undefined ? `New card in ${label}` : `New card: Enter adds it to ${label}, the AI button sends it to Triage`}
        enterKeyHint="done"
        onInput={(event) => {
          setSent(false)
          setText((event.target as HTMLInputElement).value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') (event.target as HTMLInputElement).blur()
        }}
      />
      {capture === undefined ? null : (
        <button
          type="button"
          class="icon-btn t-capture-ai"
          aria-label="Capture with AI, to Triage"
          title="Capture with AI, to Triage"
          disabled={text.trim() === '' || saving}
          // The field keeps the focus: on the phone the keyboard stays up for the next capture.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            void send(capture, true)
            field.current?.focus()
          }}
        >
          <Icon name="sparkle" size={18} />
        </button>
      )}
      <button type="submit" class="icon-btn" aria-label={`Add to ${label}`} disabled={text.trim() === '' || saving || tooLong}>
        <Icon name="plus" size={18} />
      </button>
      {tooLong ? (
        <span id="t-capture-long" class="t-capture-long">
          Over {MAX_TITLE_CHARS} characters for a title: ✦ sends it to Triage
        </span>
      ) : null}
      <span class="sr-only" role="status">
        {sent ? 'Saved to Triage. Claude is reading it.' : ''}
      </span>
    </form>
  )
}
