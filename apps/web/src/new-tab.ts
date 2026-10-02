/**
 * ⌘-click (Ctrl-click off a Mac) opens the destination in a new tab — on ANY control, not only links.
 *
 * Most of what navigates is a `<button>` calling `navigate(rest)`, and a button has no `href` for
 * the browser to open. Rather than turn every one into a link, the shell watches clicks in the
 * CAPTURE phase, before any handler runs, and remembers whether the modifier was held. `go` takes
 * that intent: if the navigation it was asked for came from such a click, it opens a tab instead.
 *
 * The intent lives for ONE TASK. A navigation an effect makes later — `/m/sessions` landing on a
 * conversation, a launch that finishes — must stay in this tab, so the intent expires on the next
 * macrotask. Not a microtask: those run between one listener and the next, before the handler that
 * navigates has even been called.
 */

export interface ClickLike {
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly button: number
}

/** The main button with ⌘ or Ctrl held — what a browser itself treats as "open in a new tab". */
export function wantsNewTab(event: ClickLike): boolean {
  return event.button === 0 && (event.metaKey || event.ctrlKey)
}

export interface NewTabIntent {
  readonly record: (event: ClickLike) => void
  /** Whether the click being handled asked for a new tab. Consumed: a second call says no. */
  readonly take: () => boolean
}

/** `later` schedules the expiry; injected so a test decides when the task is over. */
export function newTabIntent(later: (fn: () => void) => void): NewTabIntent {
  let pending = false
  return {
    record: (event) => {
      pending = wantsNewTab(event)
      if (pending) later(() => (pending = false))
    },
    take: () => {
      const wanted = pending
      pending = false
      return wanted
    },
  }
}

/** The page's one intent, fed by every click before its handlers see it. */
export const pageIntent: NewTabIntent = newTabIntent((fn) => setTimeout(fn, 0))

if (typeof window !== 'undefined') window.addEventListener('click', pageIntent.record, { capture: true })
