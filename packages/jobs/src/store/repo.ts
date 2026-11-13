/**
 * Typed queries over `jobs.db` (design D2): plain functions that take the query handle `q`.
 *
 * ROWS COME BACK FROZEN, all the way down, as the domain shapes of `types.ts`; nothing is changed in
 * place. A change is a new object from `state.ts`, written back here.
 *
 * EVERY FUNCTION THAT WRITES STATE APPENDS ITS EVENT, through `appendEvent`, on the same `q` — and so
 * in the same `tx` (requirements crit. 6). The event is an ARGUMENT, never optional: a writer cannot
 * forget it. Two writes are not entity state and carry none: `meta` (clocks such as `lastReplyPoll`)
 * and the requeue of `work` at startup.
 *
 * THE TRANSITION IS NOT DECIDED HERE: `state.ts` decides, this file stores. The one exception is the
 * startup write (`recoverOnStart`), which applies T-S4/T-A16/T-F8 and T-D6 itself because nothing
 * else runs at that moment.
 */

import { uuidv7 } from '@factotum/sessions'
import { addressTransition, appTransition, followupTransition, sendTransition } from '../state.ts'
import type {
  Application,
  Artifacts,
  Company,
  Contact,
  EventKind,
  Followup,
  JobEvent,
  Opportunity,
  ProfileVersion,
  Rule,
  Send,
} from '../types.ts'
import { fail, ok, type Result } from '../types.ts'
import type { Queries, SqlValue } from './db.ts'

type Row = Readonly<Record<string, SqlValue>>

/** What a writer is told to log; it fills in the ids of the entity it wrote. */
export interface EventSpec {
  readonly kind: EventKind
  readonly data?: Readonly<Record<string, unknown>>
  /** When it happened; `now` by default. */
  readonly at?: string
}

export interface EventInput extends EventSpec {
  readonly applicationId: string | null
  readonly companyId: string | null
}

// ── Freezing and columns ─────────────────────────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner)
    Object.freeze(value)
  }
  return value
}

const text = (row: Row, key: string): string => String(row[key] ?? '')
const textOrNull = (row: Row, key: string): string | null => (row[key] === null || row[key] === undefined ? null : String(row[key]))
const numberOrNull = (row: Row, key: string): number | null => (row[key] === null || row[key] === undefined ? null : Number(row[key]))
const json = <T>(row: Row, key: string, fallback: T): T => (row[key] === null || row[key] === undefined ? fallback : (JSON.parse(String(row[key])) as T))
const flag = (value: boolean): number => (value ? 1 : 0)

// ── Events ───────────────────────────────────────────────────────────────────────────────────────

export function appendEvent(q: Queries, input: EventInput, now: Date): JobEvent {
  const event: JobEvent = {
    id: uuidv7(now.getTime()),
    at: input.at ?? now.toISOString(),
    recordedAt: now.toISOString(),
    applicationId: input.applicationId,
    companyId: input.companyId,
    kind: input.kind,
    data: input.data ?? {},
  }
  q.run(
    'INSERT INTO events (id, at, recorded_at, application_id, company_id, kind, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    event.id,
    event.at,
    event.recordedAt,
    event.applicationId,
    event.companyId,
    event.kind,
    JSON.stringify(event.data),
  )
  return deepFreeze(event)
}

const toEvent = (row: Row): JobEvent =>
  deepFreeze({
    id: text(row, 'id'),
    at: text(row, 'at'),
    recordedAt: text(row, 'recorded_at'),
    applicationId: textOrNull(row, 'application_id'),
    companyId: textOrNull(row, 'company_id'),
    kind: text(row, 'kind') as EventKind,
    data: json(row, 'data', {}),
  })

/** In the order they were written. */
export const eventsOf = (q: Queries, applicationId: string): readonly JobEvent[] =>
  q.all<Row>('SELECT * FROM events WHERE application_id = ? ORDER BY rowid', applicationId).map(toEvent)

const withData = (spec: EventSpec, extra: Readonly<Record<string, unknown>>): EventSpec => ({ ...spec, data: { ...spec.data, ...extra } })

/** An UPDATE that touched no row: nothing was there, so no event is appended either. */
const notFound = (entity: string): Result<void> => fail('not-found', `no such ${entity}`)

// ── Companies and contacts ──────────────────────────────────────────────────────────────────────

/** A company as the seed or the scout creates it, without contacts (they have their own rows). */
export type NewCompany = Omit<Company, 'contacts'> & {
  readonly nameKey: string
  /** The text of the seeded fields, for `unknown-number` (design D6). */
  readonly record: string
}

export function insertCompany(q: Queries, company: NewCompany, event: EventSpec, now: Date): void {
  const at = now.toISOString()
  const data = { linkedin: company.linkedin, sector: company.sector, size: company.size, location: company.location, record: company.record }
  q.run(
    `INSERT INTO companies (id, name, name_key, domain, website, careers_url, ats_kind, ats_ref, is_health_employer, health_source, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    company.id,
    company.name,
    company.nameKey,
    company.domain,
    company.website,
    company.careersUrl,
    company.ats?.kind ?? null,
    company.ats?.ref ?? null,
    flag(company.isHealthEmployer),
    company.healthSource,
    JSON.stringify(data),
    at,
    at,
  )
  appendEvent(q, { ...event, applicationId: null, companyId: company.id }, now)
}

const toContact = (row: Row): Contact => {
  const status = textOrNull(row, 'address_status')
  const overrideAt = textOrNull(row, 'override_at')
  return deepFreeze({
    id: text(row, 'id'),
    companyId: text(row, 'company_id'),
    name: textOrNull(row, 'name'),
    role: textOrNull(row, 'role'),
    email: textOrNull(row, 'email'),
    sourceUrl: textOrNull(row, 'source_url'),
    address:
      status === null
        ? null
        : {
            status: status as NonNullable<Contact['address']>['status'],
            verifiedUrl: textOrNull(row, 'verified_url'),
            checkedAt: textOrNull(row, 'checked_at'),
            override: overrideAt === null ? null : { at: overrideAt },
          },
  })
}

export const getContact = (q: Queries, id: string): Contact | undefined => {
  const row = q.get<Row>('SELECT * FROM contacts WHERE id = ?', id)
  return row === undefined ? undefined : toContact(row)
}

export const contactsOfCompany = (q: Queries, companyId: string): readonly Contact[] =>
  q.all<Row>('SELECT * FROM contacts WHERE company_id = ? ORDER BY rowid', companyId).map(toContact)

const contactColumns = (contact: Contact): SqlValue[] => [
  contact.name,
  contact.role,
  contact.email,
  contact.sourceUrl,
  contact.address?.status ?? null,
  contact.address?.verifiedUrl ?? null,
  contact.address?.checkedAt ?? null,
  contact.address?.override?.at ?? null,
]

export function insertContact(q: Queries, contact: Contact, event: EventSpec, now: Date): void {
  q.run(
    `INSERT INTO contacts (company_id, name, role, email, source_url, address_status, verified_url, checked_at, override_at, id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    contact.companyId,
    ...contactColumns(contact),
    contact.id,
  )
  appendEvent(q, { ...withData(event, { contactId: contact.id }), applicationId: null, companyId: contact.companyId }, now)
}

/** Writes a contact moved by `addressTransition`, with its event. */
export function saveContact(q: Queries, contact: Contact, event: EventSpec, now: Date): Result<void> {
  const updated = q.run(
    `UPDATE contacts SET name = ?, role = ?, email = ?, source_url = ?, address_status = ?, verified_url = ?, checked_at = ?, override_at = ?
     WHERE id = ?`,
    ...contactColumns(contact),
    contact.id,
  )
  if (updated.changes === 0) return notFound('contact')
  appendEvent(q, { ...withData(event, { contactId: contact.id }), applicationId: null, companyId: contact.companyId }, now)
  return ok(undefined)
}

export function getCompany(q: Queries, id: string): Company | undefined {
  const row = q.get<Row>('SELECT * FROM companies WHERE id = ?', id)
  if (row === undefined) return undefined
  const data = json<{ linkedin: string | null; sector: string | null; size: Company['size']; location: string | null }>(row, 'data', {
    linkedin: null,
    sector: null,
    size: null,
    location: null,
  })
  const atsKind = textOrNull(row, 'ats_kind')
  return deepFreeze({
    id: text(row, 'id'),
    name: text(row, 'name'),
    domain: textOrNull(row, 'domain'),
    website: textOrNull(row, 'website'),
    careersUrl: textOrNull(row, 'careers_url'),
    linkedin: data.linkedin,
    sector: data.sector,
    size: data.size,
    location: data.location,
    isHealthEmployer: row.is_health_employer === 1,
    healthSource: textOrNull(row, 'health_source') as Company['healthSource'],
    ats: atsKind === null ? null : { kind: atsKind as NonNullable<Company['ats']>['kind'], ref: text(row, 'ats_ref') },
    contacts: contactsOfCompany(q, id),
  })
}

/** The seed matches companies by `nameKey` (design D8 step 6). */
export const companyByNameKey = (q: Queries, nameKey: string): Company | undefined => {
  const row = q.get<Row>('SELECT id FROM companies WHERE name_key = ?', nameKey)
  return row === undefined ? undefined : getCompany(q, text(row, 'id'))
}

/** `company.record` of design D6: the text of the seeded fields. */
export const companyRecord = (q: Queries, id: string): string | undefined => {
  const row = q.get<Row>('SELECT data FROM companies WHERE id = ?', id)
  return row === undefined ? undefined : json<{ record?: string }>(row, 'data', {}).record ?? ''
}

// ── Opportunities ────────────────────────────────────────────────────────────────────────────────

export function insertOpportunity(q: Queries, opportunity: Opportunity, dedupeKey: string, event: EventSpec, now: Date): void {
  const o = opportunity
  const data = { startsAt: o.startsAt, duration: o.duration, hours: o.hours, salary: o.salary, requirements: o.requirements, remote: o.remote }
  q.run(
    `INSERT INTO opportunities (id, company_id, kind, title, goal_id, url, dedupe_key, source, source_ref, posted_at, closes_at, score,
       breakdown, profile_version, status, discard_reason, checked_at, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    o.id,
    o.companyId,
    o.kind,
    o.title,
    o.goalId,
    o.url,
    dedupeKey,
    o.source,
    o.sourceRef,
    o.postedAt,
    o.closesAt,
    o.score,
    o.breakdown === null ? null : JSON.stringify(o.breakdown),
    o.profileVersion,
    o.status,
    o.discardReason,
    o.checkedAt,
    JSON.stringify(data),
  )
  appendEvent(q, { ...withData(event, { opportunityId: o.id }), applicationId: null, companyId: o.companyId }, now)
}

export function getOpportunity(q: Queries, id: string): Opportunity | undefined {
  const row = q.get<Row>('SELECT * FROM opportunities WHERE id = ?', id)
  if (row === undefined) return undefined
  const data = json<Pick<Opportunity, 'startsAt' | 'duration' | 'hours' | 'salary' | 'requirements' | 'remote'>>(row, 'data', {
    startsAt: null,
    duration: null,
    hours: null,
    salary: null,
    requirements: '',
    remote: null,
  })
  return deepFreeze({
    id: text(row, 'id'),
    companyId: text(row, 'company_id'),
    kind: text(row, 'kind') as Opportunity['kind'],
    title: text(row, 'title'),
    goalId: textOrNull(row, 'goal_id'),
    url: textOrNull(row, 'url'),
    postedAt: textOrNull(row, 'posted_at'),
    closesAt: textOrNull(row, 'closes_at'),
    ...data,
    score: numberOrNull(row, 'score'),
    breakdown: json(row, 'breakdown', null),
    profileVersion: numberOrNull(row, 'profile_version'),
    source: text(row, 'source') as Opportunity['source'],
    sourceRef: textOrNull(row, 'source_ref'),
    status: text(row, 'status') as Opportunity['status'],
    discardReason: textOrNull(row, 'discard_reason'),
    checkedAt: textOrNull(row, 'checked_at'),
  })
}

export const opportunityIdByDedupeKey = (q: Queries, dedupeKey: string): string | undefined => {
  const row = q.get<Row>('SELECT id FROM opportunities WHERE dedupe_key = ?', dedupeKey)
  return row === undefined ? undefined : text(row, 'id')
}

/** The live-ad check (N3): only `checked_at` and `status` change. */
export function saveOpportunityCheck(q: Queries, opportunity: Opportunity, event: EventSpec, now: Date): Result<void> {
  const updated = q.run('UPDATE opportunities SET checked_at = ?, status = ? WHERE id = ?', opportunity.checkedAt, opportunity.status, opportunity.id)
  if (updated.changes === 0) return notFound('opportunity')
  appendEvent(q, { ...withData(event, { opportunityId: opportunity.id }), applicationId: null, companyId: opportunity.companyId }, now)
  return ok(undefined)
}

// ── Sends ────────────────────────────────────────────────────────────────────────────────────────

const toSend = (row: Row): Send => ({
  kind: text(row, 'kind') as Send['kind'],
  followupId: textOrNull(row, 'followup_id'),
  channel: text(row, 'channel') as Send['channel'],
  messageId: textOrNull(row, 'message_id'),
  state: text(row, 'state') as Send['state'],
  at: text(row, 'at'),
  response: textOrNull(row, 'response'),
  reason: textOrNull(row, 'reason'),
  addressOverride: row.address_override === 1,
  profileVersion: numberOrNull(row, 'profile_version'),
  attempts: json(row, 'attempts', []),
})

const sendsOf = (q: Queries, applicationId: string): readonly Send[] =>
  q
    .all<Row>(
      "SELECT * FROM sends WHERE application_id = ? ORDER BY CASE kind WHEN 'initial' THEN 0 WHEN 'followup-1' THEN 1 ELSE 2 END",
      applicationId,
    )
    .map(toSend)

/** One row per `(application_id, kind)` (v5, X6): «Retry» UPDATEs it, never a second INSERT. */
function upsertSend(q: Queries, applicationId: string, send: Send): void {
  q.run(
    `INSERT INTO sends (application_id, kind, followup_id, channel, message_id, state, at, response, reason, address_override, profile_version, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (application_id, kind) DO UPDATE SET
       followup_id = excluded.followup_id, channel = excluded.channel, message_id = excluded.message_id, state = excluded.state,
       at = excluded.at, response = excluded.response, reason = excluded.reason, address_override = excluded.address_override,
       profile_version = excluded.profile_version, attempts = excluded.attempts`,
    applicationId,
    send.kind,
    send.followupId,
    send.channel,
    send.messageId,
    send.state,
    send.at,
    send.response,
    send.reason,
    flag(send.addressOverride),
    send.profileVersion,
    JSON.stringify(send.attempts),
  )
}

// ── Applications ─────────────────────────────────────────────────────────────────────────────────

function toApplication(q: Queries, row: Row): Application {
  const target = json<Omit<Application['target'], 'contactId'>>(row, 'target', { to: null, url: null, contactName: null, instruction: null })
  const id = text(row, 'id')
  return deepFreeze({
    id,
    opportunityId: text(row, 'opportunity_id'),
    companyId: text(row, 'company_id'),
    channel: text(row, 'channel') as Application['channel'],
    target: { contactId: textOrNull(row, 'contact_id'), ...target },
    cvBase: textOrNull(row, 'cv_base') as Application['cvBase'],
    state: text(row, 'state') as Application['state'],
    outcome: textOrNull(row, 'outcome') as Application['outcome'],
    rewriteFrom: textOrNull(row, 'rewrite_from') as Application['rewriteFrom'],
    holdUntil: textOrNull(row, 'hold_until'),
    version: Number(row.version),
    sends: sendsOf(q, id),
    notes: text(row, 'notes'),
    test: row.test === 1,
    warnings: json(row, 'warnings', []),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  })
}

export const getApplication = (q: Queries, id: string): Application | undefined => {
  const row = q.get<Row>('SELECT * FROM applications WHERE id = ?', id)
  return row === undefined ? undefined : toApplication(q, row)
}

/** `seed_key = '<file>#<N>'` (requirements crit. 10): what keeps a second import from duplicating. */
export const applicationBySeedKey = (q: Queries, seedKey: string): Application | undefined => {
  const row = q.get<Row>('SELECT * FROM applications WHERE seed_key = ?', seedKey)
  return row === undefined ? undefined : toApplication(q, row)
}

export function applicationsByState(q: Queries, states: readonly Application['state'][]): readonly Application[] {
  const marks = states.map(() => '?').join(', ')
  return q.all<Row>(`SELECT * FROM applications WHERE state IN (${marks}) ORDER BY rowid`, ...states).map((row) => toApplication(q, row))
}

const targetJson = (app: Application): string =>
  JSON.stringify({ to: app.target.to, url: app.target.url, contactName: app.target.contactName, instruction: app.target.instruction })

export function insertApplication(q: Queries, app: Application, extra: { readonly seedKey: string | null }, event: EventSpec, now: Date): void {
  q.run(
    `INSERT INTO applications (id, opportunity_id, company_id, contact_id, seed_key, channel, target, cv_base, state, outcome, rewrite_from,
       hold_until, version, notes, warnings, test, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    app.id,
    app.opportunityId,
    app.companyId,
    app.target.contactId,
    extra.seedKey,
    app.channel,
    targetJson(app),
    app.cvBase,
    app.state,
    app.outcome,
    app.rewriteFrom,
    app.holdUntil,
    app.version,
    app.notes,
    JSON.stringify(app.warnings),
    flag(app.test),
    app.createdAt,
    app.updatedAt,
  )
  for (const send of app.sends) upsertSend(q, app.id, send)
  appendEvent(q, { ...event, applicationId: app.id, companyId: app.companyId }, now)
}

/** Writes an application moved by `appTransition` — its row and every one of its sends — with its event. */
export function saveApplication(q: Queries, app: Application, event: EventSpec, now: Date): Result<void> {
  const updated = q.run(
    `UPDATE applications SET contact_id = ?, channel = ?, target = ?, cv_base = ?, state = ?, outcome = ?, rewrite_from = ?, hold_until = ?,
       version = ?, notes = ?, warnings = ?, updated_at = ? WHERE id = ?`,
    app.target.contactId,
    app.channel,
    targetJson(app),
    app.cvBase,
    app.state,
    app.outcome,
    app.rewriteFrom,
    app.holdUntil,
    app.version,
    app.notes,
    JSON.stringify(app.warnings),
    app.updatedAt,
    app.id,
  )
  if (updated.changes === 0) return notFound('application')
  for (const send of app.sends) upsertSend(q, app.id, send)
  appendEvent(q, { ...event, applicationId: app.id, companyId: app.companyId }, now)
  return ok(undefined)
}

// ── Artifacts ────────────────────────────────────────────────────────────────────────────────────

type ArtifactContent = Pick<Artifacts, 'cv' | 'letter' | 'form' | 'skills' | 'linkedin' | 'origin'>

/**
 * A version of an application's artifacts. It carries NO event of its own: a version is the content
 * of the event that made it (`imported` of the seed, `prepared` of a generation), written beside it in
 * the same `tx` by the same caller.
 */
export function insertArtifacts(q: Queries, applicationId: string, a: Artifacts, now: Date): void {
  const content: ArtifactContent = { cv: a.cv, letter: a.letter, form: a.form, skills: a.skills, linkedin: a.linkedin, origin: a.origin }
  q.run(
    `INSERT INTO artifacts (application_id, version, content, pdf, png, contact_hash, profile_version, rules, usage, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    applicationId,
    a.version,
    JSON.stringify(content),
    a.pdf,
    a.png,
    a.contactHash,
    a.profileVersion,
    JSON.stringify(a.rules),
    a.usage === null ? null : JSON.stringify(a.usage),
    now.toISOString(),
  )
}

export function getArtifacts(q: Queries, applicationId: string, version: number): Artifacts | undefined {
  const row = q.get<Row>('SELECT * FROM artifacts WHERE application_id = ? AND version = ?', applicationId, version)
  if (row === undefined) return undefined
  const content = json<ArtifactContent>(row, 'content', { cv: null, letter: null, form: [], skills: null, linkedin: null, origin: 'seed' })
  return deepFreeze({
    version: Number(row.version),
    cv: content.cv,
    pdf: textOrNull(row, 'pdf'),
    png: textOrNull(row, 'png'),
    contactHash: textOrNull(row, 'contact_hash'),
    letter: content.letter,
    form: content.form,
    skills: content.skills,
    linkedin: content.linkedin,
    profileVersion: Number(row.profile_version),
    rules: json(row, 'rules', []),
    usage: json(row, 'usage', null),
    origin: content.origin,
  })
}

const companyOf = (q: Queries, applicationId: string): string | null =>
  textOrNull(q.get<Row>('SELECT company_id FROM applications WHERE id = ?', applicationId) ?? {}, 'company_id')

// ── Follow-ups ───────────────────────────────────────────────────────────────────────────────────

const toFollowup = (row: Row): Followup => {
  const data = json<{ to: string | null; versions: Followup['versions'] }>(row, 'data', { to: null, versions: [] })
  return deepFreeze({
    id: text(row, 'id'),
    applicationId: text(row, 'application_id'),
    n: Number(row.n) as Followup['n'],
    channel: text(row, 'channel') as Followup['channel'],
    contactId: textOrNull(row, 'contact_id'),
    to: data.to,
    state: text(row, 'state') as Followup['state'],
    rewriteFrom: textOrNull(row, 'rewrite_from') as Followup['rewriteFrom'],
    version: Number(row.version),
    versions: data.versions,
    warnings: json(row, 'warnings', []),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  })
}

export const getFollowup = (q: Queries, id: string): Followup | undefined => {
  const row = q.get<Row>('SELECT * FROM followups WHERE id = ?', id)
  return row === undefined ? undefined : toFollowup(row)
}

export const followupsOf = (q: Queries, applicationId: string): readonly Followup[] =>
  q.all<Row>('SELECT * FROM followups WHERE application_id = ? ORDER BY n', applicationId).map(toFollowup)

export const followupsOfContact = (q: Queries, contactId: string): readonly Followup[] =>
  q.all<Row>('SELECT * FROM followups WHERE contact_id = ? ORDER BY rowid', contactId).map(toFollowup)

const followupData = (f: Followup): string => JSON.stringify({ to: f.to, versions: f.versions })

export function insertFollowup(q: Queries, f: Followup, event: EventSpec, now: Date): void {
  q.run(
    `INSERT INTO followups (id, application_id, n, channel, contact_id, state, rewrite_from, version, warnings, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.id,
    f.applicationId,
    f.n,
    f.channel,
    f.contactId,
    f.state,
    f.rewriteFrom,
    f.version,
    JSON.stringify(f.warnings),
    followupData(f),
    f.createdAt,
    f.updatedAt,
  )
  appendEvent(q, { ...withData(event, { followupId: f.id }), applicationId: f.applicationId, companyId: companyOf(q, f.applicationId) }, now)
}

/** The follow-up states that only exist beside a send row of their own (T-F6…T-F10, T-F14). */
const SEND_BACKED: ReadonlySet<Followup['state']> = new Set<Followup['state']>(['sending', 'sent', 'failed', 'send-unknown'])

/**
 * Why a follow-up and the send given with it cannot be written together, or null. A follow-up in a
 * send state without ITS row (same follow-up, same state) would be stuck after a restart: the startup
 * write only scans `sends`.
 */
function sendMismatch(f: Followup, send: Send | undefined): string | null {
  if (!SEND_BACKED.has(f.state)) return null
  if (send === undefined) return `a follow-up in ${f.state} needs its send row`
  if (send.followupId !== f.id) return `the send row given is not this follow-up's (${String(send.followupId)})`
  if (send.state !== f.state) return `the send row is ${send.state}, the follow-up ${f.state}`
  return null
}

/**
 * Writes a follow-up moved by `followupTransition` and, when given, its own send row (T-F6…T-F14).
 * In `sending`/`sent`/`failed`/`send-unknown` the send is REQUIRED: a `conflict` otherwise, before
 * anything is written.
 */
export function saveFollowup(q: Queries, f: Followup, event: EventSpec, now: Date, send?: Send): Result<void> {
  const mismatch = sendMismatch(f, send)
  if (mismatch !== null) return fail('conflict', mismatch)
  const updated = q.run(
    'UPDATE followups SET channel = ?, contact_id = ?, state = ?, rewrite_from = ?, version = ?, warnings = ?, data = ?, updated_at = ? WHERE id = ?',
    f.channel,
    f.contactId,
    f.state,
    f.rewriteFrom,
    f.version,
    JSON.stringify(f.warnings),
    followupData(f),
    f.updatedAt,
    f.id,
  )
  if (updated.changes === 0) return notFound('follow-up')
  if (send !== undefined) upsertSend(q, f.applicationId, send)
  appendEvent(q, { ...withData(event, { followupId: f.id }), applicationId: f.applicationId, companyId: companyOf(q, f.applicationId) }, now)
  return ok(undefined)
}

// ── Profile versions, rules, meta ────────────────────────────────────────────────────────────────

/** Never rewrites: a profile is saved as a NEW version (design D7). */
export function insertProfileVersion(q: Queries, saved: ProfileVersion, event: EventSpec, now: Date): void {
  q.run('INSERT INTO profile_versions (version, created_at, data) VALUES (?, ?, ?)', saved.version, saved.createdAt, JSON.stringify(saved.profile))
  appendEvent(q, { ...withData(event, { version: saved.version }), applicationId: null, companyId: null }, now)
}

export function latestProfileVersion(q: Queries): ProfileVersion | undefined {
  const row = q.get<Row>('SELECT * FROM profile_versions ORDER BY version DESC LIMIT 1')
  if (row === undefined) return undefined
  return deepFreeze({ version: Number(row.version), createdAt: text(row, 'created_at'), profile: json(row, 'data', {}) as ProfileVersion['profile'] })
}

const toRule = (row: Row): Rule =>
  deepFreeze({
    id: text(row, 'id'),
    text: text(row, 'text'),
    scope: text(row, 'scope') as Rule['scope'],
    enabled: row.enabled === 1,
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  })

export const listRules = (q: Queries): readonly Rule[] => q.all<Row>('SELECT * FROM rules ORDER BY created_at, rowid').map(toRule)

export const getRule = (q: Queries, id: string): Rule | undefined => {
  const row = q.get<Row>('SELECT * FROM rules WHERE id = ?', id)
  return row === undefined ? undefined : toRule(row)
}

export function insertRule(q: Queries, rule: Rule, event: EventSpec, now: Date): void {
  q.run(
    'INSERT INTO rules (id, text, scope, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    rule.id,
    rule.text,
    rule.scope,
    flag(rule.enabled),
    rule.createdAt,
    rule.updatedAt,
  )
  appendEvent(q, { ...withData(event, { ruleId: rule.id }), applicationId: null, companyId: null }, now)
}

export function updateRule(q: Queries, rule: Rule, event: EventSpec, now: Date): Result<void> {
  const updated = q.run('UPDATE rules SET text = ?, scope = ?, enabled = ?, updated_at = ? WHERE id = ?', rule.text, rule.scope, flag(rule.enabled), rule.updatedAt, rule.id)
  if (updated.changes === 0) return notFound('rule')
  appendEvent(q, { ...withData(event, { ruleId: rule.id }), applicationId: null, companyId: null }, now)
  return ok(undefined)
}

export const getMeta = (q: Queries, key: string): string | undefined => {
  const row = q.get<Row>('SELECT value FROM meta WHERE key = ?', key)
  return row === undefined ? undefined : text(row, 'value')
}

export function setMeta(q: Queries, key: string, value: string): void {
  q.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value)
}

// ── The startup write (design D13 `start` step 2) ───────────────────────────────────────────────

/** Something the startup write found and could not move: said, never hidden in a count. */
export interface Skipped {
  readonly kind: 'send' | 'contact'
  /** `<applicationId>/<kind>` for a send, the contact id for a contact. */
  readonly id: string
  readonly reason: string
}

export interface Recovered {
  /** Moved, not merely found: what could not move is in `skipped`. */
  readonly sends: number
  readonly work: number
  readonly contacts: number
  readonly skipped: readonly Skipped[]
}

/** Moves one `sending` row and its owner; the reason when the row itself cannot move, else null. */
function recoverSend(q: Queries, applicationId: string, row: Send, now: Date): string | null {
  const restarted = { kind: row.kind, restarted: true }
  const sendMoved = sendTransition(row, { type: 'smtp-unknown' }, now) // T-S4: always valid from `sending`
  if (!sendMoved.ok) return sendMoved.error.reason
  if (row.kind === 'initial') {
    const app = getApplication(q, applicationId)
    const moved = app === undefined ? undefined : appTransition(app, { type: 'smtp-unknown' }, now) // T-A16 + T-S4
    if (moved?.ok === true && saveApplication(q, moved.value, { kind: 'send-unknown', data: restarted }, now).ok) return null
  } else {
    const f = row.followupId === null ? undefined : getFollowup(q, row.followupId)
    const fMoved = f === undefined ? undefined : followupTransition(f, { type: 'smtp-unknown' }, now) // T-F8
    if (fMoved?.ok === true && saveFollowup(q, fMoved.value, { kind: 'send-unknown', data: restarted }, now, sendMoved.value).ok) return null
  }
  // The owner of the row is not in `sending` (it should be): the row alone still leaves `sending`, so
  // no send waits forever, and the event says the two disagreed.
  upsertSend(q, applicationId, sendMoved.value)
  const data = { ...restarted, followupId: row.followupId, ownerOutOfStep: true }
  appendEvent(q, { kind: 'send-unknown', data, applicationId, companyId: companyOf(q, applicationId) }, now)
  return null
}

/** T-D6 on one contact; the reason when it cannot move, else null. */
function recoverContact(q: Queries, contact: Contact, now: Date): string | null {
  const moved = addressTransition(contact, { type: 'restart' }, now)
  if (!moved.ok) return moved.error.reason
  const saved = saveContact(q, moved.value, { kind: 'address-checked', data: { found: false, restarted: true } }, now)
  return saved.ok ? null : saved.error.reason
}

/**
 * Only the daemon runs this, in its opening `tx` — never the CLI, which would mark a send in flight
 * as doubtful (design D3, «La postulación de prueba»). Every `sends` row in `sending` (initial and
 * follow-ups) → `send-unknown`; `work.running → queued`; every contact `checking → unverified` with
 * `checkedAt = null` and its override kept (T-D6; the requeue is the check queue's, N4).
 */
export function recoverOnStart(q: Queries, now: Date): Recovered {
  const sending = q.all<Row>("SELECT * FROM sends WHERE state = 'sending' ORDER BY rowid")
  const sendSkips = sending.flatMap((row): Skipped[] => {
    const send = toSend(row)
    const applicationId = text(row, 'application_id')
    const reason = recoverSend(q, applicationId, send, now)
    return reason === null ? [] : [{ kind: 'send', id: `${applicationId}/${send.kind}`, reason }]
  })
  const work = q.run("UPDATE work SET state = 'queued', updated_at = ? WHERE state = 'running'", now.toISOString()).changes
  const checking = q.all<Row>("SELECT * FROM contacts WHERE address_status = 'checking' ORDER BY rowid").map(toContact)
  const contactSkips = checking.flatMap((contact): Skipped[] => {
    const reason = recoverContact(q, contact, now)
    return reason === null ? [] : [{ kind: 'contact', id: contact.id, reason }]
  })
  return {
    sends: sending.length - sendSkips.length,
    work,
    contacts: checking.length - contactSkips.length,
    skipped: [...sendSkips, ...contactSkips],
  }
}

// ── The check queue's selections (task N4, design D9 «Cuándo se comprueba») ──────────────────────

/** Before the first send leaves: what the seed import may still send by email. */
const UNSENT_STATES: readonly Application['state'][] = ['draft', 'generating', 'in-review', 'ready', 'rewriting']

const uniqueIds = (rows: readonly Row[]): readonly string[] => [...new Set(rows.map((row) => text(row, 'id')))]

/**
 * The contacts of the email applications, not sent yet, imported from the given seed files
 * (`seed_key = '<file>#<N>'`, D8), in the order of the files and then of the rows; each contact once.
 * The caller passes only the files the module sends (never a `byHand` one).
 */
export function seedCheckContacts(q: Queries, files: readonly string[]): readonly string[] {
  const marks = UNSENT_STATES.map(() => '?').join(', ')
  const rows = files.flatMap((file) =>
    q.all<Row>(
      `SELECT contact_id AS id FROM applications
       WHERE channel = 'email' AND contact_id IS NOT NULL AND state IN (${marks}) AND substr(seed_key, 1, ?) = ?
       ORDER BY rowid`,
      ...UNSENT_STATES,
      file.length + 1,
      `${file}#`,
    ),
  )
  return uniqueIds(rows)
}

/**
 * The contacts of the next batch's email items, in a batch's order, until R1's own order exists
 * (design D15 «Qué entra al lote»): follow-ups `draft`/`ready`, then applications `ready`, then
 * `in-review`, each by score (none last); never the test application nor one held past today.
 * A contact may come more than once: one per item.
 */
export function batchCandidateContacts(q: Queries, now: Date): readonly string[] {
  const today = now.toISOString().slice(0, 10)
  const followups = q.all<Row>(
    "SELECT contact_id AS id FROM followups WHERE channel = 'email' AND contact_id IS NOT NULL AND state IN ('draft', 'ready') ORDER BY created_at, rowid",
  )
  const applications = q.all<Row>(
    `SELECT a.contact_id AS id FROM applications a JOIN opportunities o ON o.id = a.opportunity_id
     WHERE a.channel = 'email' AND a.contact_id IS NOT NULL AND a.test = 0 AND a.state IN ('ready', 'in-review')
       AND (a.hold_until IS NULL OR a.hold_until <= ?)
     ORDER BY CASE a.state WHEN 'ready' THEN 0 ELSE 1 END, o.score IS NULL, o.score DESC, a.rowid`,
    today,
  )
  return [...followups, ...applications].map((row) => text(row, 'id'))
}

/**
 * The contacts the startup write moved `checking → unverified` (T-D6) and no check has touched since:
 * their last `address-checked` event is the `restarted` one. They go back to the front (D9 «Al arrancar»).
 */
export function restartedContacts(q: Queries): readonly string[] {
  const rows = q.all<Row>(
    `SELECT c.id FROM contacts c
     WHERE c.address_status = 'unverified' AND c.checked_at IS NULL
       AND (SELECT json_extract(e.data, '$.restarted') FROM events e
            WHERE e.kind = 'address-checked' AND json_extract(e.data, '$.contactId') = c.id
            ORDER BY e.rowid DESC LIMIT 1) = 1
     ORDER BY c.rowid`,
  )
  return uniqueIds(rows)
}

// ── Seed import: drafts whose CV was never queued (review fix of S6) ──────────────────────────────

/**
 * The `draft` applications imported from the given seed files (`seed_key = '<file>#<N>'`, D8) that have
 * no `gen_requests(id, 'cv')` row, in the order of the files and then of the rows. What the import
 * queues: a CV the queue refused, or one lost to a crash after the import's `tx`, is queued again.
 */
export function seedDraftsWithoutCv(q: Queries, files: readonly string[]): readonly { readonly id: string; readonly seedKey: string }[] {
  return files.flatMap((file) =>
    q
      .all<Row>(
        `SELECT a.id, a.seed_key FROM applications a
         WHERE a.state = 'draft' AND substr(a.seed_key, 1, ?) = ?
           AND NOT EXISTS (SELECT 1 FROM gen_requests g WHERE g.entity_id = a.id AND g.kind = 'cv')
         ORDER BY a.rowid`,
        file.length + 1,
        `${file}#`,
      )
      .map((row) => ({ id: text(row, 'id'), seedKey: text(row, 'seed_key') })),
  )
}

// ── The generation queue (tasks G2a–G5, design D10; lane 1) ─────────────────────────────────────
//
// The `work` table and `gen_requests` (D3 «La guarda»). Writing a `work` row is not entity state and
// carries no event (like the startup requeue); the queue writes the events of the entities it moves.

/** design D10. `reprint` runs no Claude: it does not count for `concurrency`, one at a time. */
export const WORK_KINDS = ['cv', 'letter', 'rewrite', 'verify', 'classify', 'extract', 'score', 'keeper', 'reprint'] as const
export type WorkKind = (typeof WORK_KINDS)[number]
export type Lane = 'interactive' | 'bulk'
export type WorkState = 'queued' | 'running' | 'done' | 'failed'

export interface Work {
  readonly id: string
  readonly kind: WorkKind
  /** The entity it works on: an application, or a follow-up for a follow-up's `rewrite`. */
  readonly ref: string
  readonly lane: Lane
  readonly state: WorkState
  readonly attempts: number
  /** ISO; null = now. */
  readonly notBefore: string | null
  /** The last failure, ours (never CLI text). */
  readonly reason: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

const toWork = (row: Row): Work =>
  deepFreeze({
    id: text(row, 'id'),
    kind: text(row, 'kind') as WorkKind,
    ref: text(row, 'ref'),
    lane: text(row, 'lane') as Lane,
    state: text(row, 'state') as WorkState,
    attempts: Number(row.attempts),
    notBefore: textOrNull(row, 'not_before'),
    reason: textOrNull(row, 'reason'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  })

export function insertWork(q: Queries, work: Work): void {
  q.run(
    'INSERT INTO work (id, kind, ref, lane, state, attempts, not_before, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    work.id,
    work.kind,
    work.ref,
    work.lane,
    work.state,
    work.attempts,
    work.notBefore,
    work.reason,
    work.createdAt,
    work.updatedAt,
  )
}

export const getWork = (q: Queries, id: string): Work | undefined => {
  const row = q.get<Row>('SELECT * FROM work WHERE id = ?', id)
  return row === undefined ? undefined : toWork(row)
}

/** Writes the state, attempts, `not_before` and reason a run moved. */
export function saveWork(q: Queries, work: Work): Result<void> {
  const updated = q.run(
    'UPDATE work SET state = ?, attempts = ?, not_before = ?, reason = ?, updated_at = ? WHERE id = ?',
    work.state,
    work.attempts,
    work.notBefore,
    work.reason,
    work.updatedAt,
    work.id,
  )
  return updated.changes === 0 ? notFound('work') : ok(undefined)
}

/** `queued` and due at `at` (no `not_before`, or reached), oldest first. */
export const dueWork = (q: Queries, at: string): readonly Work[] =>
  q.all<Row>("SELECT * FROM work WHERE state = 'queued' AND (not_before IS NULL OR not_before <= ?) ORDER BY created_at, rowid", at).map(toWork)

export const workByState = (q: Queries, state: WorkState): readonly Work[] =>
  q.all<Row>('SELECT * FROM work WHERE state = ? ORDER BY created_at, rowid', state).map(toWork)

/** The class of a generation request (D3 «La guarda»): `GenKind` of `types.ts`. */
export type GenRequestKind = 'letter' | 'cv' | 'followup'

/** The latest request per (entity, class): enqueueing overwrites it. */
export function setGenRequest(q: Queries, entityId: string, kind: GenRequestKind, workId: string): void {
  q.run(
    'INSERT INTO gen_requests (entity_id, kind, work_id) VALUES (?, ?, ?) ON CONFLICT (entity_id, kind) DO UPDATE SET work_id = excluded.work_id',
    entityId,
    kind,
    workId,
  )
}

export interface GenRequest {
  readonly kind: GenRequestKind
  readonly workId: string
  /** The state of its `work` row; null when the row is gone. */
  readonly state: WorkState | null
}

/** Every class requested of an entity, with the state of the work that holds it. */
export const genRequestsOf = (q: Queries, entityId: string): readonly GenRequest[] =>
  q
    .all<Row>('SELECT g.kind, g.work_id, w.state FROM gen_requests g LEFT JOIN work w ON w.id = g.work_id WHERE g.entity_id = ? ORDER BY g.kind', entityId)
    .map((row) => deepFreeze({ kind: text(row, 'kind') as GenRequestKind, workId: text(row, 'work_id'), state: textOrNull(row, 'state') as WorkState | null }))

export function deleteMeta(q: Queries, key: string): void {
  q.run('DELETE FROM meta WHERE key = ?', key)
}

/**
 * Wave 2 (G5, D8 step 7): the `draft` applications of these seed files held to a day no later than
 * `lastHoldDay` (= today + 7 d) whose CV was never requested, in the order of the files and the rows.
 */
export function heldDraftsDue(q: Queries, files: readonly string[], lastHoldDay: string): readonly string[] {
  return files.flatMap((file) =>
    q
      .all<Row>(
        `SELECT a.id FROM applications a
         WHERE a.state = 'draft' AND a.hold_until IS NOT NULL AND a.hold_until <= ? AND substr(a.seed_key, 1, ?) = ?
           AND NOT EXISTS (SELECT 1 FROM gen_requests g WHERE g.entity_id = a.id AND g.kind = 'cv')
         ORDER BY a.rowid`,
        lastHoldDay,
        file.length + 1,
        `${file}#`,
      )
      .map((row) => text(row, 'id')),
  )
}
