/**
 * The changes after delivery (design D2, D9; criterion 36): ask for one with text or dictation, its own
 * gate with the preview, and the history with each change's URLs. One change at a time; once
 * approved, it is only redeployed — «Start redeploy» if a redeploy did not finish, never the change
 * again. Approving launches the redeploy from here, as approving a stage launches the next (D5).
 */

import { useRef, useState } from 'preact/hooks'
import type { Api as DictationApi } from '../../shared/dictation/contract.ts'
import type { Change, Mockup } from '../types.ts'
import { Gate } from './gate.tsx'
import { NoteDictation } from './inputs.tsx'
import { OpenUrl } from './links.tsx'
import type { LaunchApis, LaunchOutcome } from './launch.ts'
import { redoStage, requestChange, startStage } from './launch.ts'
import { changeActions, changeLine, openChange, requestChangeBlocked, safeUrl } from './model.ts'
import { StagePanel } from './stage.tsx'

export interface ChangesProps {
  readonly mockup: Mockup
  readonly apis: LaunchApis
  readonly busy: boolean
  readonly dictationApi: DictationApi | undefined
  /** Runs a launch with the screen's busy state and notice (pipeline.tsx). */
  readonly run: (act: () => Promise<LaunchOutcome>) => Promise<void>
  /** Approves the change; with a 200, the redeploy's launch (pipeline.tsx). */
  readonly approve: (change: Change) => Promise<void>
  readonly abandon: (runId: string) => Promise<void>
  readonly openSession: (sessionId: string) => void
}

export function Changes(props: ChangesProps) {
  const { mockup, apis, busy } = props
  const open = openChange(mockup)
  const ctx = { sessions: apis.sessions !== undefined, now: new Date() }
  const history = mockup.changes.filter((change) => change.status === 'done').reverse()
  return (
    <div class="mk-changes">
      {open === undefined ? <RequestChange {...props} blocked={requestChangeBlocked(mockup, ctx)} /> : <OpenChange {...props} change={open} now={ctx.now} />}
      <section>
        <h3 class="mk-h3">History</h3>
        {history.length === 0 ? <p class="mk-small">No change has reached production yet.</p> : null}
        <ul class="mk-change-list">
          {history.map((change) => (
            <li key={change.id} class="mk-change">
              <p class="mk-change-text">{change.text}</p>
              <p class="mk-cap">
                {changeLine(change)}
                {change.history.at(-1)?.at === undefined ? '' : ` · approved ${change.history.at(-1)?.at.slice(0, 10)}`}
              </p>
              {safeUrl(change.previewUrl) === undefined ? null : (
                <a class="mk-mono mk-ellipsis" href={safeUrl(change.previewUrl)} target="_blank" rel="noopener noreferrer">
                  {change.previewUrl}
                </a>
              )}
            </li>
          ))}
        </ul>
      </section>
      {safeUrl(mockup.urls.prod) === undefined ? null : <OpenUrl label="Open production" url={mockup.urls.prod} />}
    </div>
  )
}

/** The open change: its gate when it waits on you, otherwise the stage panel's actions (crit. 36). */
function OpenChange(props: ChangesProps & { readonly change: Change; readonly now: Date }) {
  const { mockup, apis, busy, change } = props
  const actions = changeActions(mockup, change, { sessions: apis.sessions !== undefined, now: props.now })
  const kind = change.phase === 'change' ? 'change' : 'redeploy'
  const changeId = change.id
  if (change.status === 'waiting') {
    return (
      <div class="mk-change-open">
        <p class="mk-change-text">«{change.text}»</p>
        <Gate
          label="The change"
          step={change}
          actions={actions}
          busy={busy}
          previewUrl={change.previewUrl}
          dictationApi={props.dictationApi}
          onApprove={() => void props.approve(change)}
          onChoose={() => undefined}
          onRedo={(comment) => void props.run(() => redoStage(apis, mockup.id, { changeId }, comment))}
        />
      </div>
    )
  }
  const current = change.run
  // A redo's retry goes through the change's gate again, with its comment (D6).
  const retry = async (): Promise<void> => {
    if (current === undefined) return
    await props.abandon(current.id)
    await props.run(() => (current.redo === undefined ? startStage(apis, mockup.id, kind, changeId) : redoStage(apis, mockup.id, { changeId }, current.redo.comment)))
  }
  return (
    <div class="mk-change-open">
      <p class="mk-change-text">«{change.text}»</p>
      <StagePanel
        label={kind === 'change' ? 'Change' : 'Redeploy'}
        step={change}
        actions={actions}
        busy={busy}
        onStart={() => void props.run(() => startStage(apis, mockup.id, kind, changeId))}
        onRetry={() => void retry()}
        onAbandon={() => void (current === undefined ? undefined : props.abandon(current.id))}
        onOpenSession={props.openSession}
      />
      <p class="mk-cap">{changeLine(change)}</p>
    </div>
  )
}

function RequestChange({ mockup, apis, busy, dictationApi, run, blocked }: ChangesProps & { readonly blocked: string | undefined }) {
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const ask = async (): Promise<void> => {
    await run(() => requestChange(apis, mockup.id, text.trim()))
    setText('')
  }
  return (
    <section class="mk-gate">
      <label class="mk-h3" for="mk-change">
        Request a change
      </label>
      <div class="mk-redo-field">
        <textarea id="mk-change" ref={box} placeholder="What did the client ask for?" value={text} onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)} />
        {dictationApi === undefined ? null : <NoteDictation api={dictationApi} text={text} setText={setText} box={box} />}
      </div>
      <button type="button" class="btn primary mk-big" disabled={busy || blocked !== undefined || text.trim() === ''} onClick={() => void ask()}>
        Request the change
      </button>
      {blocked === undefined ? <p class="mk-cap">A session makes it and deploys a preview; you review it here before it goes to production.</p> : <p class="mk-cap">{blocked}.</p>}
    </section>
  )
}
