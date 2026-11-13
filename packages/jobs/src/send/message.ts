/**
 * What step 2 of D9 puts on the wire, read from the store (pure over `q`).
 *
 * THE SLOTS ARE FILLED HERE, with the profile version the row recorded at step 1 (D6 «Huecos»): the
 * stored texts keep `{signature}`. A slot left unfilled is refused (`unfilled-slot: <slot>`), never
 * sent half-filled.
 *
 * THE VERSION IS THE ONE STEP 1 PINNED on the row (`artifactsVersion`, D9 revisión del corte 1a):
 * the initial's letter and PDF, a follow-up's text. When the entity has another version now (or the
 * row pins none) nothing goes: `stale-version`.
 *
 * THE INITIAL carries its version's PDF; A FOLLOW-UP NEVER DOES (v4, A3). In the thread (D12 rule 1)
 * a follow-up's subject is `Re: <the subject of the initial that went>`, `inReplyTo` the last `smtp`
 * row `sent`, `references` all of them in order; without a thread (rule 2) it is its own version's
 * subject, and no threading headers.
 */

import { fillSlots } from '../build/slots.ts'
import type { Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { fail, ok, type Application, type Profile, type Result, type Send, type SendKind } from '../types.ts'
import { recipientOf } from './recipient.ts'

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
  /** The contact the send goes to, and the copy of its email stored beside the draft. */
  readonly contactId: string | null
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

/** `stale-version` unless the row pins exactly the version the entity has now. */
export function pinnedVersion(row: Send, current: number): Result<number> {
  return row.artifactsVersion === current ? ok(current) : fail('blocked', 'stale-version')
}

function initialDraft(q: Queries, app: Application, row: Send, profile: Profile): Result<Draft> {
  const pinned = pinnedVersion(row, app.version)
  if (!pinned.ok) return pinned
  const artifacts = repo.getArtifacts(q, app.id, pinned.value)
  if (artifacts?.letter == null) return fail('blocked', 'missing-letter')
  if (artifacts.pdf === null) return fail('blocked', 'missing-cv')
  const { subject, body } = artifacts.letter
  return ok({ contactId: app.target.contactId, to: app.target.to, subject, body, attachment: { filename: cvFileName(profile), path: artifacts.pdf } })
}

function followupDraft(q: Queries, app: Application, row: Send): Result<Draft> {
  const f = row.followupId === null ? undefined : repo.getFollowup(q, row.followupId)
  if (f === undefined) return fail('conflict', 'the follow-up has no current version')
  const pinned = pinnedVersion(row, f.version)
  if (!pinned.ok) return pinned
  const version = f.versions.find((v) => v.version === pinned.value)
  if (version === undefined) return fail('conflict', 'the follow-up has no current version')
  const thread = app.sends.filter((s) => s.kind !== row.kind && s.channel === 'smtp' && s.state === 'sent' && s.messageId !== null).map((s) => s.messageId as string)
  if (thread.length === 0) return ok({ contactId: f.contactId, to: f.to, subject: version.subject, body: version.body }) // D12 rule 2
  // The subject of the initial that went: the version its row pinned (a manual one pins none: the current).
  const initial = app.sends.find((s) => s.kind === 'initial')
  const initialSubject = repo.getArtifacts(q, app.id, initial?.artifactsVersion ?? app.version)?.letter?.subject ?? null
  return ok({
    contactId: f.contactId,
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
  const draft = kind === 'initial' ? initialDraft(q, app, row, profile.profile) : followupDraft(q, app, row)
  if (!draft.ok) return draft
  const { contactId, to: storedTo, subject, body, ...rest } = draft.value
  const recipient = recipientOf(q, contactId, storedTo)
  if (!recipient.ok) return recipient
  const { to } = recipient.value
  if (subject === null) return fail('blocked', 'missing-subject')
  const filledSubject = fillSlots(subject, profile.profile)
  const filledText = fillSlots(body, profile.profile)
  const missing = [...new Set([...filledSubject.missing, ...filledText.missing])]
  if (missing.length > 0) return fail('blocked', `unfilled-slot: ${missing.join(', ')}`)
  const unfit = unfitText(filledSubject.text, filledText.text)
  if (unfit !== null) return fail('blocked', unfit)
  return ok({ ...rest, to, subject: filledSubject.text, text: filledText.text, messageId: row.messageId })
}

/** D9 step 2 (revisión de E): a blank subject or body never goes out, nor a subject that would break its header line. */
function unfitText(subject: string, text: string): string | null {
  if (subject.trim() === '') return 'empty-subject'
  if (/[\r\n]/.test(subject)) return 'bad-subject'
  if (text.trim() === '') return 'empty-body'
  return null
}
