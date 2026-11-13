/**
 * The pieces of a review card (design D15 «Revisión»): the «To:» line with its buttons, the letter,
 * the CV, the form answers, the owner's notes and «Gaps vs the ad». Each draws what `model.ts` says.
 */

import { useEffect, useState } from 'preact/hooks'
import { ARM_EXPIRY_MS, pressArmed } from './arm.ts'
import type { Api, ApplicationCard, ContactView, FormAnswer } from './contract.ts'
import { addressControls, formMark, safeModulePath, type Label } from './model.ts'

export function Labels({ labels }: { readonly labels: readonly Label[] }) {
  return (
    <ul class="j-labels">
      {labels.map((label, at) => (
        <li key={at} class={`j-label ${label.tone}`}>
          {label.text}
          {/* The detail is read, not hovered: a phone has no hover and a screen reader skips `title`. */}
          {label.title === null ? null : <span class="j-label-detail"> · {label.title}</span>}
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
  const [armedAt, setArmedAt] = useState<number | null>(null)
  const armed = armedAt !== null
  const controls = addressControls(contact?.address ?? null, { now: new Date(), entity, formUrl })
  const switchLabel = entity === 'followup' ? 'Switch to LinkedIn note' : 'Switch to form'
  // The arm goes by itself after ARM_EXPIRY_MS (`arm.ts`).
  useEffect(() => {
    if (armedAt === null) return
    const timer = setTimeout(() => setArmedAt(null), Math.max(0, armedAt + ARM_EXPIRY_MS - Date.now()))
    return () => clearTimeout(timer)
  }, [armedAt])
  const anyway = () => {
    const press = pressArmed(armedAt, Date.now())
    setArmedAt(press.armedAt)
    if (press.fire) onSendAnyway()
  }
  return (
    <div class="j-to">
      <p class="j-to-line">
        To: {to ?? '—'} <span class={`j-address ${controls.label.replace(/[^a-z]/g, '')}`}>· {controls.label}</span>
      </p>
      {decided ? null : (
        <div class="j-to-acts">
          {controls.sendAnyway === 'hidden' ? null : (
            <button type="button" class={`btn sm${armed ? ' primary' : ''}`} disabled={busy || controls.sendAnyway === 'off'} onClick={anyway} onBlur={() => setArmedAt(null)}>
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
  // The daemon's paths go to `api.url` only as plain module paths (`safeModulePath`).
  const png = safeModulePath(cv.png)
  const pdf = safeModulePath(cv.pdf)
  return (
    <section class="j-doc j-cv">
      <h3 class="j-doc-title">CV{cv.base === null ? '' : ` — ${cv.base}`}</h3>
      {png === null ? <p class="j-quiet">No preview yet.</p> : <img class="j-cv-png" src={api.url(png)} alt="The CV, first page" />}
      {pdf === null ? null : (
        <a class="btn sm" href={api.url(pdf)} download>
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
              <span class="j-mark" aria-hidden="true">
                {mark}
              </span>
              <span class="sr-only">{mark === '✓' ? 'ok' : 'check this'}</span>
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
