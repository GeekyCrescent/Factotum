/**
 * A stage that is not at its gate (criteria 14, 17, 18, 19, 41): its status line and what it offers —
 * Start, Retry and Open session for a stalled run, Abandon for a run that never got its session, and
 * the reason when launching is off.
 */

import type { StageId, Step } from '../types.ts'
import { Glyph } from './glyph.tsx'
import { Icon } from './icon.tsx'
import { statusLine, type StageActions } from './model.ts'

export function StagePanel({
  label,
  step,
  actions,
  busy,
  onStart,
  onRetry,
  onAbandon,
  onOpenSession,
}: {
  readonly stage: StageId
  readonly label: string
  readonly step: Step
  readonly actions: StageActions
  readonly busy: boolean
  readonly onStart: () => void
  readonly onRetry: () => void
  readonly onAbandon: () => void
  readonly onOpenSession: (sessionId: string) => void
}) {
  const start = actions.start
  const retry = actions.retry
  return (
    <div class="mk-stage">
      <div class={`mk-stage-head mk-st-${step.status}`}>
        <Glyph status={step.status} /> <span>{label}</span> <span class="mk-cap">{statusLine(step)}</span>
      </div>
      {step.status === 'running' ? <p class="mk-small">A session is working on it. The gate opens here when it submits, with a push.</p> : null}
      {step.status === 'locked' ? <p class="mk-small">It opens when the stage before it is approved.</p> : null}
      {start === undefined ? null : (
        <button type="button" class="btn primary mk-big" disabled={busy || start.disabled !== undefined} onClick={onStart}>
          {busy ? 'Launching…' : `Start ${label.toLowerCase()}`}
        </button>
      )}
      {start?.disabled === undefined ? null : <p class="mk-cap">{start.disabled === 'next cut' ? 'Arrives in the next cut of the module.' : `${start.disabled}.`}</p>}
      {actions.openSession === undefined ? null : (
        <button type="button" class="btn" onClick={() => onOpenSession(actions.openSession ?? '')}>
          <Icon name="terminal-window" size={16} /> Open session
        </button>
      )}
      {retry === undefined ? null : (
        <>
          <p class="mk-small">Answer in the session to carry on, or retry: the run is abandoned and a new session starts.</p>
          <button type="button" class="btn mk-big" disabled={busy || retry.disabled !== undefined} onClick={onRetry}>
            <Icon name="arrow-clockwise" size={16} /> Retry
          </button>
          {retry.disabled === undefined ? null : <p class="mk-cap">{retry.disabled}.</p>}
        </>
      )}
      {actions.abandon ? (
        <>
          <p class="mk-small">This run has no session after 2 minutes: the screen may have closed while it launched.</p>
          <button type="button" class="btn" disabled={busy} onClick={onAbandon}>
            Abandon the run
          </button>
        </>
      ) : null}
    </div>
  )
}
