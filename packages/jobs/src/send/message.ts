/**
 * What step 2 of D9 puts on the wire, read from the store (pure over `q`).
 *
 * THE SLOTS ARE FILLED HERE, with the profile version the row recorded at step 1 (D6 «Huecos»): the
 * stored texts keep `{signature}`. A slot left unfilled is refused (`unfilled-slot: <slot>`), never
 * sent half-filled.
 *
 * THE INITIAL carries the current version's PDF; A FOLLOW-UP NEVER DOES (v4, A3). In the thread
 * (D12 rule 1) a follow-up's subject is `Re: <the initial's subject>`, `inReplyTo` the last `smtp`
 * row `sent`, `references` all of them in order; without a thread (rule 2) it is its own version's
 * subject, and no threading headers.
 */

import { fillSlots } from '../build/slots.ts'
import type { Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { fail, ok, type Application, type Profile, type Result, type Send, type SendKind } from '../types.ts'

export interface Outgoing {
  readonly to: string
  readonly subject: string
  readonly text: string
  readonly messageId: string
  readonly inReplyTo?: string
  readonly references?: readonly string[]
  readonly attachment?: { readonly filename: string; readonly path: string }
}

interface Draft {
  readonly to: string | null
  readonly subject: string | null
  readonly body: string
  readonly inReplyTo?: string
  readonly references?: readonly string[]
  readonly attachment?: { readonly filename: string; readonly path: string }
}

/** `Juan-Rodrigo-Ferro-Rayon-CV.pdf`: the profile's name, ASCII, from a closed alphabet (D5). */
export function cvFileName(profile: Profile): string {
  const ascii = profile.identity.name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${ascii === '' ? 'CV' : `${ascii}-CV`}.pdf`
}

const reSubject = (subject: string): string => (/^re:/i.test(subject) ? subject : `Re: ${subject}`)

function initialDraft(q: Queries, app: Application, profile: Profile): Result<Draft> {
  const artifacts = repo.getArtifacts(q, app.id, app.version)
  if (artifacts?.letter == null) return fail('blocked', 'missing-letter')
  if (artifacts.pdf === null) return fail('blocked', 'missing-cv')
  const { subject, body } = artifacts.letter
  return ok({ to: app.target.to, subject, body, attachment: { filename: cvFileName(profile), path: artifacts.pdf } })
}

function followupDraft(q: Queries, app: Application, row: Send): Result<Draft> {
  const f = row.followupId === null ? undefined : repo.getFollowup(q, row.followupId)
  const version = f?.versions.find((v) => v.version === f.version)
  if (f === undefined || version === undefined) return fail('conflict', 'the follow-up has no current version')
  const thread = app.sends.filter((s) => s.kind !== row.kind && s.channel === 'smtp' && s.state === 'sent' && s.messageId !== null).map((s) => s.messageId as string)
  if (thread.length === 0) return ok({ to: f.to, subject: version.subject, body: version.body }) // D12 rule 2
  const initialSubject = repo.getArtifacts(q, app.id, app.version)?.letter?.subject ?? null
  return ok({
    to: f.to,
    subject: initialSubject === null ? null : reSubject(initialSubject),
    body: version.body,
    inReplyTo: thread[thread.length - 1] as string,
    references: thread,
  }) // D12 rule 1
}

/** The message of the row in flight, or why it cannot go (a reason with no value of the owner's in it). */
export function outgoingFor(q: Queries, id: string, kind: SendKind): Result<Outgoing> {
  const app = repo.getApplication(q, id)
  const row = app?.sends.find((s) => s.kind === kind)
  if (app === undefined || row === undefined || row.state !== 'sending' || row.messageId === null) return fail('conflict', 'the send is not in flight')
  const profile = row.profileVersion === null ? undefined : repo.profileVersionOf(q, row.profileVersion)
  if (profile === undefined) return fail('blocked', 'missing-profile')
  const draft = kind === 'initial' ? initialDraft(q, app, profile.profile) : followupDraft(q, app, row)
  if (!draft.ok) return draft
  const { to, subject, body, ...rest } = draft.value
  if (to === null) return fail('blocked', 'no-address')
  if (subject === null) return fail('blocked', 'missing-subject')
  const filledSubject = fillSlots(subject, profile.profile)
  const filledText = fillSlots(body, profile.profile)
  const missing = [...new Set([...filledSubject.missing, ...filledText.missing])]
  if (missing.length > 0) return fail('blocked', `unfilled-slot: ${missing.join(', ')}`)
  return ok({ ...rest, to, subject: filledSubject.text, text: filledText.text, messageId: row.messageId })
}
