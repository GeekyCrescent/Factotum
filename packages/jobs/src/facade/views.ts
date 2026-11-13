/**
 * The screen's views of the store (design D15; `modules/jobs/client/contract.ts`): pure over a read.
 *
 * TEXTS ARE SHOWN FILLED, NEVER STORED FILLED (D6 «Huecos»): every letter, answer, note and follow-up
 * goes through `fillSlots` with today's profile; a slot whose field is empty stays as it was (its
 * block is already a warning). Files are MODULE PATHS for `api.url`, never paths on disk.
 */

import { fillSlots } from '../build/slots.ts'
import type { ReviewItemRef } from '../review/batch.ts'
import type { SeenBatch, SeenItem } from '../review/seen.ts'
import { cvFileName } from '../send/message.ts'
import type { Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import type { Application, Followup, Profile, Send } from '../types.ts'
import type { ApplicationCard, BatchView, CompanyRef, ContactView, FollowupCard, JobStatus, ReplyCard, ReviewItem, RewriteInfo, SendView } from './types.ts'

const IDLE: JobStatus = { state: 'idle', reason: null }
const NO_COMPANY: CompanyRef = { id: '', name: '' }

const fill = (text: string, profile: Profile): string => fillSlots(text, profile).text
const fillOrNull = (text: string | null, profile: Profile): string | null => (text === null ? null : fill(text, profile))

export const sendView = (send: Send): SendView => ({ kind: send.kind, state: send.state, at: send.at, reason: send.reason })

function companyRef(q: Queries, id: string): CompanyRef {
  const company = repo.getCompany(q, id)
  return company === undefined ? NO_COMPANY : { id: company.id, name: company.name }
}

function contactView(q: Queries, id: string | null): ContactView | null {
  const contact = id === null ? undefined : repo.getContact(q, id)
  return contact === undefined ? null : { id: contact.id, name: contact.name, email: contact.email, address: contact.address }
}

/** The latest request of a class, read as the card shows it; `reprint` apart from the `cv` it shares a class with. */
function jobsOf(q: Queries, applicationId: string): ApplicationCard['jobs'] {
  const status = (pick: (kind: string, workKind: string) => boolean): JobStatus => {
    for (const request of repo.genRequestsOf(q, applicationId)) {
      const work = repo.getWork(q, request.workId)
      if (work === undefined || !pick(request.kind, work.kind)) continue
      if (work.state === 'queued' || work.state === 'running') return { state: 'pending', reason: null }
      if (work.state === 'failed') return { state: 'failed', reason: work.reason }
    }
    return IDLE
  }
  return {
    cv: status((kind, work) => kind === 'cv' && work === 'cv'),
    letter: status((kind, work) => kind === 'letter' && work === 'letter'),
    reprint: status((kind, work) => kind === 'cv' && work === 'reprint'),
  }
}

export function applicationCard(q: Queries, app: Application, profile: Profile): ApplicationCard {
  const opportunity = repo.getOpportunity(q, app.opportunityId)
  const company = repo.getCompany(q, app.companyId)
  const artifacts = repo.getArtifacts(q, app.id, app.version)
  const base = `a/${app.id}/v/${app.version}`
  const isEmail = app.channel === 'email'
  return {
    id: app.id,
    state: app.state,
    channel: app.channel,
    test: app.test,
    version: app.version,
    company: company === undefined ? NO_COMPANY : { id: company.id, name: company.name },
    role: opportunity?.title ?? '',
    hours: opportunity?.hours ?? null,
    score: opportunity?.score ?? null,
    adUrl: opportunity?.url ?? null,
    formUrl: isEmail ? (opportunity?.url ?? company?.careersUrl ?? null) : null,
    contact: isEmail ? contactView(q, app.target.contactId) : null,
    to: app.target.to,
    letter: artifacts?.letter == null ? null : { subject: fillOrNull(artifacts.letter.subject, profile), body: fill(artifacts.letter.body, profile) },
    form: (artifacts?.form ?? []).map((answer) => ({ ...answer, answer: fill(answer.answer, profile) })),
    linkedin: fillOrNull(artifacts?.linkedin ?? null, profile),
    cv: {
      base: app.cvBase,
      png: artifacts?.png == null ? null : `${base}/preview.png`,
      pdf: artifacts?.pdf == null ? null : `${base}/${cvFileName(profile)}`,
      tailored: null,
    },
    notes: app.notes,
    warnings: app.warnings,
    jobs: jobsOf(q, app.id),
    sends: app.sends.map(sendView),
  }
}

export function followupCard(q: Queries, row: Followup, profile: Profile): FollowupCard {
  const app = repo.getApplication(q, row.applicationId)
  const version = row.versions.find((v) => v.version === row.version)
  return {
    id: row.id,
    applicationId: row.applicationId,
    n: row.n,
    state: row.state,
    channel: row.channel,
    company: app === undefined ? NO_COMPANY : companyRef(q, app.companyId),
    role: app === undefined ? '' : (repo.getOpportunity(q, app.opportunityId)?.title ?? ''),
    contact: contactView(q, row.contactId),
    to: row.to,
    subject: fillOrNull(version?.subject ?? null, profile),
    body: fill(version?.body ?? '', profile),
    warnings: row.warnings,
  }
}

/** The last event of `kind` about this entity (a follow-up's carry `followupId`). */
function lastEvent(q: Queries, applicationId: string, followupId: string | null, kind: string) {
  return repo
    .eventsOf(q, applicationId)
    .filter((e) => e.kind === kind && (e.data.followupId ?? null) === followupId)
    .at(-1)
}

const stringOr = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function rewriteInfo(q: Queries, item: Extract<SeenItem, { kind: 'rewritten' }>, profile: Profile, applicationId: string): RewriteInfo {
  const followupId = item.target === 'followup' ? item.id : null
  const instruction = stringOr(lastEvent(q, applicationId, followupId, 'instruction')?.data.instruction)
  const reason = item.failed ? stringOr(lastEvent(q, applicationId, followupId, 'rewrite-failed')?.data.reason) : null
  const before =
    item.target === 'application'
      ? (repo.getArtifacts(q, item.id, item.fromVersion)?.letter?.body ?? null)
      : (repo.getFollowup(q, item.id)?.versions.find((v) => v.version === item.fromVersion)?.body ?? null)
  return { fromVersion: item.fromVersion, failed: item.failed, instruction, reason, before: fillOrNull(before, profile) }
}

function replyCard(q: Queries, item: Extract<SeenItem, { kind: 'reply' }>): ReplyCard {
  const event = repo.eventsOf(q, item.applicationId).find((e) => e.id === item.eventId)
  const app = repo.getApplication(q, item.applicationId)
  const data = event?.data ?? {}
  return {
    applicationId: item.applicationId,
    eventId: item.eventId,
    company: app === undefined ? NO_COMPANY : companyRef(q, app.companyId),
    from: stringOr(data.from) ?? '',
    subject: stringOr(data.subject) ?? '',
    summary: stringOr(data.summary) ?? '',
    link: stringOr(data.link),
  }
}

/** One item for the screen; null when its entity is gone (the next read prunes it). */
export function reviewItem(q: Queries, item: SeenItem, profile: Profile): ReviewItem | null {
  const head = { itemId: item.itemId, seen: item.seen }
  switch (item.kind) {
    case 'application': {
      const app = repo.getApplication(q, item.applicationId)
      return app === undefined ? null : { ...head, kind: 'application', application: applicationCard(q, app, profile) }
    }
    case 'followup': {
      const row = repo.getFollowup(q, item.followupId)
      return row === undefined ? null : { ...head, kind: 'followup', followup: followupCard(q, row, profile) }
    }
    case 'rewritten': {
      if (item.target === 'application') {
        const app = repo.getApplication(q, item.id)
        return app === undefined ? null : { ...head, kind: 'rewritten', target: 'application', application: applicationCard(q, app, profile), rewrite: rewriteInfo(q, item, profile, app.id) }
      }
      const row = repo.getFollowup(q, item.id)
      return row === undefined
        ? null
        : { ...head, kind: 'rewritten', target: 'followup', followup: followupCard(q, row, profile), rewrite: rewriteInfo(q, item, profile, row.applicationId) }
    }
    case 'reply':
      return { ...head, kind: 'reply', reply: replyCard(q, item) }
    case 'proposal':
      return { ...head, kind: 'proposal', proposalId: item.proposalId }
  }
}

/** The application or follow-up an item is about, for «TEST» and «still rewriting». */
function entityState(q: Queries, item: SeenItem): { readonly test: boolean; readonly rewriting: boolean } {
  const app = (id: string) => repo.getApplication(q, id)
  const row = (id: string) => repo.getFollowup(q, id)
  switch (item.kind) {
    case 'application': {
      const found = app(item.applicationId)
      return { test: found?.test === true, rewriting: found?.state === 'rewriting' }
    }
    case 'followup':
      return { test: false, rewriting: row(item.followupId)?.state === 'rewriting' }
    case 'rewritten': {
      const state = item.target === 'application' ? app(item.id)?.state : row(item.id)?.state
      return { test: item.target === 'application' && app(item.id)?.test === true, rewriting: state === 'rewriting' }
    }
    default:
      return { test: false, rewriting: false }
  }
}

export function batchView(q: Queries, batch: SeenBatch, profile: Profile): BatchView {
  const states = batch.items.map((item) => entityState(q, item))
  return {
    id: batch.id,
    test: states.some((s) => s.test),
    items: batch.items.flatMap((item) => reviewItem(q, item, profile) ?? []),
    cursor: batch.cursor,
    results: batch.results,
    rewriting: states.filter((s) => s.rewriting).length,
  }
}

/** `ready` applications (not the test one) that the open batch does not hold: «Start next batch». */
export function readyOutside(q: Queries, items: readonly ReviewItemRef[]): number {
  const held = new Set(items.flatMap((item) => (item.kind === 'application' ? [item.applicationId] : item.kind === 'rewritten' ? [item.id] : [])))
  return repo.applicationsByState(q, ['ready']).filter((app) => !app.test && !held.has(app.id)).length
}
