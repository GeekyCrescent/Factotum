/**
 * The pieces of a review card (design D15 «Revisión»): the «To:» line with its buttons, the letter,
 * the CV, the form answers, the owner's notes and «Gaps vs the ad». Each draws what `model.ts` says.
 */

import { useState } from 'preact/hooks'
import type { Api, ApplicationCard, ContactView, FormAnswer } from './contract.ts'
import { addressControls, formMark, type Label } from './model.ts'

export function Labels({ labels }: { readonly labels: readonly Label[] }) {
  return (
    <ul class="j-labels">
      {labels.map((label, at) => (
        <li key={at} class={`j-label ${label.tone}`} title={label.title ?? undefined}>
          {label.text}
        </li>
      ))}
    </ul>
  )
}

export interface ToLineProps {
  readonly entity: 'application' | 'followup'
  readonly to: string | null
  readonly contact: ContactView | null
  readonly formUrl: string | null
  /** Read-only: an item already decided shows the line, not the buttons. */
  readonly decided: boolean
  readonly busy: boolean
  readonly onSendAnyway: () => void
  readonly onSwitch: () => void
}

/**
 * «To: … · verified / checking… / unverified / sent anyway» and, by the D3 table, «Send anyway»
 * (a second click confirms, T-D5) and «Switch to form» / «Switch to LinkedIn note».
 */
export function ToLine({ entity, to, contact, formUrl, decided, busy, onSendAnyway, onSwitch }: ToLineProps) {
  const [armed, setArmed] = useState(false)
  const controls = addressControls(contact?.address ?? null, { now: new Date(), entity, formUrl })
  const switchLabel = entity === 'followup' ? 'Switch to LinkedIn note' : 'Switch to form'
  const anyway = () => {
    if (!armed) return setArmed(true)
    setArmed(false)
    onSendAnyway()
  }
  return (
    <div class="j-to">
      <p class="j-to-line">
        To: {to ?? '—'} <span class={`j-address ${controls.label.replace(/[^a-z]/g, '')}`}>· {controls.label}</span>
      </p>
      {decided ? null : (
        <div class="j-to-acts">
          {controls.sendAnyway === 'hidden' ? null : (
            <button type="button" class={`btn sm${armed ? ' primary' : ''}`} disabled={busy || controls.sendAnyway === 'off'} onClick={anyway}>
              {armed ? 'Click again to send anyway' : 'Send anyway'}
            </button>
          )}
          {controls.switchChannel === 'hidden' ? null : (
            <button type="button" class="btn sm" disabled={busy || controls.switchChannel === 'off'} onClick={onSwitch}>
              {switchLabel}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function Letter({ title, subject, body }: { readonly title: string; readonly subject: string | null; readonly body: string | null }) {
  return (
    <section class="j-doc">
      <h3 class="j-doc-title">{title}</h3>
      {subject === null ? null : <p class="j-subject">Subject: {subject}</p>}
      {body === null ? <p class="j-quiet">No text yet.</p> : <p class="j-text">{body}</p>}
    </section>
  )
}

export function Cv({ api, cv }: { readonly api: Api; readonly cv: ApplicationCard['cv'] }) {
  return (
    <section class="j-doc j-cv">
      <h3 class="j-doc-title">CV{cv.base === null ? '' : ` — ${cv.base}`}</h3>
      {cv.png === null ? <p class="j-quiet">No preview yet.</p> : <img class="j-cv-png" src={api.url(cv.png)} alt="The CV, first page" />}
      {cv.pdf === null ? null : (
        <a class="btn sm" href={api.url(cv.pdf)} download>
          Download PDF
        </a>
      )}
      {cv.tailored === null ? null : <p class="j-quiet">tailored: {cv.tailored}</p>}
    </section>
  )
}

export function FormAnswers({ form }: { readonly form: readonly FormAnswer[] }) {
  if (form.length === 0) return null
  return (
    <section class="j-form">
      <h3 class="j-doc-title">Form answers</h3>
      <ul>
        {form.map((answer, at) => {
          const mark = formMark(answer)
          return (
            <li key={at} class={`j-answer${mark === '⚠' ? ' warn' : ''}`}>
              <span class="j-mark" aria-label={mark === '✓' ? 'ok' : 'check this'}>
                {mark}
              </span>
              <div>
                <p class="j-question">{answer.question}</p>
                <p class="j-text">{answer.answer}</p>
                {answer.hint === null ? null : <p class="j-quiet">{answer.hint}</p>}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function Notes({ notes }: { readonly notes: string }) {
  if (notes.trim() === '') return null
  return (
    <details class="j-notes">
      <summary>Owner notes</summary>
      <p class="j-text">{notes}</p>
    </details>
  )
}

/** «Gaps vs the ad» (v4, N2): amber, informative; skipping or instructing is the owner's call. */
export function Gaps({ gaps }: { readonly gaps: readonly string[] }) {
  if (gaps.length === 0) return null
  return (
    <section class="j-gaps">
      <h3 class="j-doc-title">Gaps vs the ad</h3>
      <ul>
        {gaps.map((gap, at) => (
          <li key={at}>{gap}</li>
        ))}
      </ul>
    </section>
  )
}
