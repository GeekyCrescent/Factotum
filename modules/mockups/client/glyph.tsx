/**
 * A stage's status by colour AND shape (criterion 38): dot, ring, turning arc, amber diamond, red
 * triangle, green check — drawn like the board's status glyphs, as the chosen mockup B shows them.
 */

import type { StepStatus } from '../types.ts'

export function Glyph({ status, size = 16 }: { readonly status: StepStatus; readonly size?: number }) {
  return (
    <svg class={`mk-g mk-g-${status}`} viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
      {status === 'locked' ? <circle cx="8" cy="8" r="2.4" fill="currentColor" /> : null}
      {status === 'ready' ? <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6" /> : null}
      {status === 'running' ? (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity=".28" stroke-width="1.6" />
          <path class="mk-spin" d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </>
      ) : null}
      {status === 'waiting' ? (
        <>
          <path d="M8 1.6 14.4 8 8 14.4 1.6 8Z" fill="currentColor" />
          <path d="M8 5v3.6M8 10.8v.2" stroke="var(--bg)" stroke-width="1.6" stroke-linecap="round" />
        </>
      ) : null}
      {status === 'stalled' ? (
        <>
          <path d="M8 1.8 14.6 13.6H1.4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
          <path d="M8 6.4v3M8 11.4v.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </>
      ) : null}
      {status === 'done' ? (
        <>
          <circle cx="8" cy="8" r="6.6" fill="currentColor" />
          <path d="M5.2 8.2l1.9 1.9 3.7-3.9" fill="none" stroke="var(--bg)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </>
      ) : null}
    </svg>
  )
}
