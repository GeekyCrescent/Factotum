/**
 * A gate (design D6; criteria 27, 28, 29, 30): approve — or, at a choosing stage, choose one of its
 * options (`options.tsx`) — or redo with a comment written or dictated. A
 * redo whose launch failed brings its comment back into the box (`pendingComment`, criterion 15).
 * The gate never expires; it waits here.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { Api as DictationApi } from '../../shared/dictation/contract.ts'
import type { Step } from '../types.ts'
import { Glyph } from './glyph.tsx'
import { NoteDictation } from './inputs.tsx'
import { OpenUrl } from './links.tsx'
import type { StageActions } from './model.ts'
import { Options } from './options.tsx'

export function Gate({
  label,
  step,
  actions,
  busy,
  previewUrl,
  dictationApi,
  onApprove,
  onChoose,
  onRedo,
}: {
  readonly label: string
  readonly step: Step
  readonly actions: StageActions
  readonly busy: boolean
  /** A gate on a deployed app (build, a change): the preview the owner opens before deciding. */
  readonly previewUrl?: string | undefined
  readonly dictationApi: DictationApi | undefined
  readonly onApprove: () => void
  readonly onChoose: (optionId: string) => void
  readonly onRedo: (comment: string) => void
}) {
  const [comment, setComment] = useState(step.pendingComment ?? '')
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => setComment(step.pendingComment ?? ''), [step.pendingComment])
  const redoOff = actions.redo.disabled
  return (
    <div class="mk-gate" id="mk-gate">
      <div class="mk-gate-head">
        <Glyph status="waiting" /> {label} is waiting on you
      </div>
      {step.summary === undefined ? null : <p class="mk-summary">«{step.summary}»</p>}
      <OpenUrl label="Open the preview" url={previewUrl} />
      {actions.gate === 'choose' ? (
        <Options options={step.options ?? []} busy={busy} enabled={actions.choose} onChoose={onChoose} />
      ) : (
        <button type="button" class="btn primary mk-big" disabled={busy || !actions.approve} onClick={onApprove}>
          Approve
        </button>
      )}
      <label class="mk-cap" for="mk-comment">
        Redo with a comment
      </label>
      <div class="mk-redo-field">
        <textarea id="mk-comment" ref={box} placeholder="What should change in the next version?" value={comment} onInput={(e) => setComment((e.currentTarget as HTMLTextAreaElement).value)} />
        {dictationApi === undefined ? null : <NoteDictation api={dictationApi} text={comment} setText={setComment} box={box} />}
      </div>
      {step.pendingComment === undefined ? null : <p class="mk-cap">Your last redo did not launch. The comment is back here.</p>}
      <button type="button" class="btn mk-big" disabled={busy || redoOff !== undefined || comment.trim() === ''} onClick={() => onRedo(comment.trim())}>
        Redo with this comment
      </button>
      {redoOff === undefined ? null : <p class="mk-cap">{redoOff}.</p>}
    </div>
  )
}
