/**
 * Quick capture by hand (criterion 9): a title and Enter, straight to the column it was typed from —
 * Backlog or Todo, the only two the owner creates in. No AI: that capture, with the microphone, is the
 * second cut (E4, G3).
 */

import { useState } from 'preact/hooks'
import { Icon } from './icon.tsx'

export function QuickCapture({
  target,
  label,
  add,
  sticky = false,
}: {
  readonly target: 'backlog' | 'todo'
  readonly label: string
  /** Resolves with whether the card was saved. */
  readonly add: (title: string, status: 'backlog' | 'todo') => Promise<boolean>
  /** The phone's: fixed at the bottom of the screen. */
  readonly sticky?: boolean
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
    <form class={sticky ? 't-capture t-capture-sticky' : 't-capture'} onSubmit={(event) => void submit(event)}>
      <input
        class="t-capture-input"
        type="text"
        value={text}
        maxLength={200}
        placeholder={`Add to ${label}`}
        aria-label={`New card in ${label}`}
        enterKeyHint="done"
        onInput={(event) => setText((event.target as HTMLInputElement).value)}
      />
      <button type="submit" class="icon-btn" aria-label={`Add to ${label}`} disabled={text.trim() === '' || saving}>
        <Icon name="plus" size={18} />
      </button>
    </form>
  )
}
