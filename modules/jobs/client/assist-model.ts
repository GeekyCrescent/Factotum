/**
 * The assist panel, as data (spec 2026-11-12-postulaciones, design D9 «El panel de asistencia», D15;
 * requirements crit. 47, 48, 50). Pure: `assist-panel.tsx` draws what this says.
 *
 * FOR `form`, `platform` AND `linkedin` there is nothing to send: approving moves the application to
 * `approved`, the panel opens with what to paste — each text with its slots already filled, the
 * package's `hint` beside an answer but never in what is copied — and «Mark as sent» closes the loop.
 * In `linkedin` (B1) the instruction goes on top and there is no «Open ad». An EMAIL with a LinkedIn
 * note gets the panel too, after its approve, with only the note: nothing to mark.
 */

import type { ReviewItem } from './contract.ts'
import { safeHref, safeModulePath, type SendKey } from './model.ts'

export interface AssistCopy {
  readonly label: string
  /** What «Copy» puts on the clipboard: the text alone. */
  readonly text: string
  /** A note for the owner, shown, never copied. */
  readonly hint: string | null
}

export interface AssistView {
  readonly title: string
  readonly instruction: string | null
  readonly links: readonly { readonly label: string; readonly href: string }[]
  readonly copies: readonly AssistCopy[]
  readonly skills: { readonly tick: readonly string[]; readonly doNotTick: readonly string[] } | null
  /** «Download CV (PDF)»: a module path for `api.url`. */
  readonly pdf: string | null
  /** «Mark as sent» on this send; null = nothing to mark. */
  readonly mark: SendKey | null
}

const copy = (label: string, text: string | null | undefined, hint: string | null = null): readonly AssistCopy[] =>
  text === null || text === undefined || text.trim() === '' ? [] : [{ label, text, hint }]

const NO_LINKS: AssistView['links'] = []

/** The panel for the item approved; null when approving it needs none. */
export function assistOf(item: ReviewItem): AssistView | null {
  if (item.kind === 'application' || (item.kind === 'rewritten' && item.target === 'application')) {
    const app = item.application
    const mark: SendKey = { applicationId: app.id, kind: 'initial', company: app.company.name }
    const pdf = safeModulePath(app.cv.pdf)
    const base = { instruction: null, skills: null, pdf, mark }
    if (app.channel === 'email') {
      if (copy('LinkedIn note', app.linkedin).length === 0) return null
      return { ...base, title: 'LinkedIn note', links: NO_LINKS, copies: copy('LinkedIn note', app.linkedin), pdf: null, mark: null }
    }
    if (app.channel === 'linkedin') {
      return { ...base, title: 'LinkedIn message', instruction: app.instruction ?? null, links: NO_LINKS, copies: copy('Message', app.linkedin ?? app.letter?.body) }
    }
    const ad = safeHref(app.adUrl)
    const form = safeHref(app.targetUrl ?? null)
    const links = [...(ad === null ? [] : [{ label: 'Open ad', href: ad }]), ...(form === null || form === ad ? [] : [{ label: 'Open form', href: form }])]
    const copies = [
      ...copy('Cover letter', app.letter?.body),
      ...app.form.flatMap((answer) => copy(answer.question, answer.answer, answer.hint)),
      ...copy('LinkedIn note', app.linkedin),
    ]
    return { ...base, title: `Apply on the ${app.channel}`, links, copies, skills: app.skills ?? null }
  }
  if (item.kind === 'followup' || item.kind === 'rewritten') {
    const followup = item.followup
    if (followup.channel !== 'linkedin') return null
    const mark: SendKey = { applicationId: followup.applicationId, kind: `followup-${followup.n}`, company: followup.company.name }
    return { title: 'LinkedIn follow-up', instruction: null, links: NO_LINKS, copies: copy('Message', followup.body), skills: null, pdf: null, mark }
  }
  return null
}

/**
 * Whether closing `closing` closes the panel open now. A close that arrives late — «Mark as sent»
 * answered after «Later», a second Escape — finds it already gone (or another one open) and must not
 * move the review on a second time, past an item never seen.
 */
export function closesOpenPanel<T extends object>(open: T | undefined, closing: T): boolean {
  return open === closing
}

export type CopyState = 'idle' | 'copied' | 'failed'

export interface CopyButton {
  readonly text: string
  /** Its accessible name: every Copy on the panel says what it copies. */
  readonly label: string
  /** For the live region: what happened, once. */
  readonly announce: string
  /** Goes back to «Copy» after a moment — a failure too, so the owner can try again. */
  readonly resets: boolean
}

const COPY_TEXT: Readonly<Record<CopyState, string>> = { idle: 'Copy', copied: 'Copied', failed: 'Could not copy' }

export function copyButton(state: CopyState, label: string): CopyButton {
  const announce = state === 'copied' ? `${label} copied` : state === 'failed' ? `Could not copy ${label}` : ''
  return { text: COPY_TEXT[state], label: `Copy: ${label}`, announce, resets: state !== 'idle' }
}
