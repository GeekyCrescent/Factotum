/**
 * Two captures in one field (the owner's choice, 2026-10-15: Enter goes to the AI):
 * - WITH AI (criteria 21–24), Enter or ✦: the text goes to `POST /capture`; the card lands in Triage at
 *   once and claude fills it in afterwards. The field then says so, until the next keystroke. This is
 *   the fast path the 10 s of criterion 24 is about.
 * - BY HAND (criterion 9), the «+»: straight to the column it was typed for — Backlog or Todo, the only
 *   two the owner creates in. No AI.
 * Without a `capture` (no AI on this board, or a column's «+» pointed the field at its column), Enter
 * adds by hand, as before.
 * The microphone joins the field with the shared dictation (G3).
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
  onLeave,
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
  /** The field lost the focus: a column's «+» stops pointing at its column. */
  readonly onLeave?: () => void
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
  const byHand = (): void => {
    // Too long for a title: the note by the field says so, and Enter is the way.
    if (tooLong) return
    void send((title) => add(title, target), false)
  }
  const submit = (event: Event): void => {
    event.preventDefault()
    if (capture === undefined) byHand()
    else void send(capture, true)
    // In the gesture: a tap on ✦ can move the focus on some phones, and the keyboard must stay up.
    field.current?.focus()
  }
  /**
   * The field was left: a column's «+» stops pointing at its column. Not when the focus went to a button
   * of this same form (its own «+»), nor when the whole window lost it (alt-tab to copy a text).
   */
  const leave = (event: FocusEvent): void => {
    if (onLeave === undefined || !document.hasFocus()) return
    const to = event.relatedTarget
    if (to instanceof Node && (event.currentTarget as HTMLInputElement).form?.contains(to)) return
    onLeave()
  }
  const placeholder = sent
    ? 'In Triage, claude is reading it. Add another'
    : capture === undefined
      ? sticky
        ? `Add to ${label}`
        : `Add to ${label}, press N from anywhere`
      : sticky
        ? 'Capture a task'
        : 'Capture a task, press N from anywhere'

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
        aria-label={capture === undefined ? `New card in ${label}` : 'Capture a task: Enter sends it to Triage'}
        enterKeyHint="done"
        onInput={(event) => {
          setSent(false)
          setText((event.target as HTMLInputElement).value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') (event.target as HTMLInputElement).blur()
        }}
        onBlur={leave}
      />
      {capture === undefined ? (
        <button
          type="submit"
          class="icon-btn"
          aria-label={`Add to ${label}`}
          disabled={text.trim() === '' || saving}
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
        >
          <Icon name="plus" size={18} />
        </button>
      ) : (
        <>
          {/* Both keep the field's focus: on the phone the keyboard stays up for the next capture. */}
          <button
            type="button"
            class="icon-btn"
            aria-label={`Add to ${label} by hand, without AI`}
            title={`Add to ${label} by hand, without AI`}
            disabled={text.trim() === '' || saving || tooLong}
            onPointerDown={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              byHand()
              field.current?.focus()
            }}
          >
            <Icon name="plus" size={18} />
          </button>
          <button
            type="submit"
            class="icon-btn t-capture-ai"
            aria-label="Send to Triage, read by AI"
            title="Send to Triage, read by AI (Enter)"
            disabled={text.trim() === '' || saving}
            onPointerDown={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
          >
            <Icon name="sparkle" size={18} />
          </button>
        </>
      )}
      {tooLong ? (
        <span id="t-capture-long" class="t-capture-long">
          {capture === undefined
            ? `Over ${MAX_TITLE_CHARS} characters for a title`
            : `Over ${MAX_TITLE_CHARS} characters to add by hand: Enter sends it to Triage`}
        </span>
      ) : null}
      <span class="sr-only" role="status">
        {sent ? 'Saved to Triage. Claude is reading it.' : ''}
      </span>
    </form>
  )
}
