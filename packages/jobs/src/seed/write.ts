/**
 * Writing a plan (design D8 steps 6–7), inside the import's ONE `tx`: companies with their contacts
 * and opportunity, then one application per new entry — `draft`, version 1 of its artifacts
 * (`origin: 'seed'`, `cv: null`), its `seed_key`, `holdUntil` from the config, an `imported` event.
 *
 * THE SEED DOES NOT LINT: without a CV nothing can reach `ready`; the linter runs when the CV returns.
 * Texts keep their slots (`{signature}`, `{portfolio}`…), never profile data (design D6).
 */

import { uuidv7 } from '@factotum/sessions'
import { addressTransition, isStaleCheck, newApplication } from '../state.ts'
import type { Queries } from '../store/db.ts'
import {
  companyByNameKey,
  contactsOfCompany,
  insertApplication,
  insertArtifacts,
  insertCompany,
  insertContact,
  insertOpportunity,
  opportunityIdByDedupeKey,
  type NewCompany,
} from '../store/repo.ts'
import { MAX_REQUIREMENTS_CHARS } from '../shape.ts'
import type { Application, Artifacts, Contact, Opportunity, Result } from '../types.ts'
import { recordSent, sentByHand } from './by-hand.ts'
import type { SeedCompany, SeedContact } from './companies.ts'
import { bracketTokens } from './markdown.ts'
import type { PackageEntry, SeedAddress } from './package.ts'
import type { PlannedCompany, PlannedEntry } from './plan.ts'

export interface CreatedApplication {
  readonly planned: PlannedEntry
  readonly app: Application
  /** The contacts of the entry's addresses never checked (or checked long ago): for the checks of N4. */
  readonly checkContactIds: readonly string[]
}

const IMPORTED = { kind: 'imported' } as const
export const opportunityKey = (companyKey: string): string => `seed:${companyKey}`

function companyRow(seed: SeedCompany, id: string): NewCompany {
  const { contacts: _contacts, ...fields } = seed
  return { ...fields, id }
}

function seedOpportunity(planned: PlannedCompany, companyId: string, profileVersion: number): Opportunity | null {
  const o = planned.opportunity
  if (o === null) return null
  return {
    ...EMPTY_OPPORTUNITY,
    id: uuidv7(),
    companyId,
    kind: o.kind,
    title: o.title,
    url: o.url,
    closesAt: o.closesAt,
    startsAt: o.startsAt,
    salary: o.salary,
    requirements: o.requirements.slice(0, MAX_REQUIREMENTS_CHARS),
    score: o.score,
    breakdown: o.breakdown,
    profileVersion,
  }
}

const EMPTY_OPPORTUNITY: Omit<Opportunity, 'id' | 'companyId' | 'kind' | 'title'> = {
  goalId: null,
  url: null,
  postedAt: null,
  closesAt: null,
  startsAt: null,
  duration: null,
  hours: null,
  salary: null,
  requirements: '',
  score: null,
  breakdown: null,
  profileVersion: null,
  source: 'seed',
  sourceRef: null,
  remote: null,
  status: 'open',
  discardReason: null,
  checkedAt: null,
}

/** The opportunity of a company the companies file did not have: from the entry itself. */
function entryOpportunity(entry: PackageEntry, companyId: string): Opportunity {
  return {
    ...EMPTY_OPPORTUNITY,
    id: uuidv7(),
    companyId,
    kind: entry.adStatus === null ? 'outreach' : 'vacancy',
    title: entry.role ?? entry.company,
    url: entry.target.url,
  }
}

const blankContact = (companyId: string, from: Partial<Contact> = {}): Contact => ({
  id: uuidv7(),
  companyId,
  name: null,
  role: null,
  email: null,
  sourceUrl: null,
  address: null,
  ...from,
})

/** T-D1: an address enters `unverified`, or `verified` with the website when the package saw it with a date. */
function withAddress(contact: Contact, email: string, seenAt: string | null, now: Date): Contact {
  const created = addressTransition(contact, { type: 'create', email, seen: seenAt === null ? null : { url: seenAt } }, now)
  // An address the rule of `to` refuses keeps its text, without a state: approving it is `no-address`.
  return created.ok ? created.value : { ...contact, email }
}

function insertSeedContact(q: Queries, companyId: string, seed: SeedContact, now: Date): void {
  const contact = blankContact(companyId, { name: seed.name, role: seed.role, sourceUrl: seed.sourceUrl })
  insertContact(q, seed.email === null ? contact : withAddress(contact, seed.email, null, now), IMPORTED, now)
}

function ensureCompany(q: Queries, planned: PlannedCompany, profileVersion: number, now: Date): boolean {
  if (companyByNameKey(q, planned.key) !== undefined) return false
  const id = uuidv7()
  insertCompany(q, companyRow(planned.seed, id), IMPORTED, now)
  for (const contact of planned.seed.contacts) insertSeedContact(q, id, contact, now)
  const opportunity = seedOpportunity(planned, id, profileVersion)
  if (opportunity !== null) insertOpportunity(q, opportunity, opportunityKey(planned.key), IMPORTED, now)
  return true
}

/** A company with no `website` (made from an entry): the site of the address's own domain. */
const siteOf = (email: string): string => `https://${email.slice(email.lastIndexOf('@') + 1).toLowerCase()}`

/** The contact of an address of the entry: the company's own with that email, or a new one. */
function ensureAddress(q: Queries, companyId: string, website: string | null, address: SeedAddress, now: Date): Contact {
  const email = address.email.toLowerCase()
  const known = contactsOfCompany(q, companyId).find((c) => c.email?.toLowerCase() === email)
  if (known !== undefined) return known
  const seenAt = address.status === 'verified' ? (website ?? siteOf(address.email)) : null
  const contact = withAddress(blankContact(companyId), address.email, seenAt, now)
  insertContact(q, contact, IMPORTED, now)
  return contact
}

/** «Robin Vale — Operations Director (…); Kim Doe — CEO» → «Robin Vale»; «none verified» → null. */
function contactNameOf(contact: string | null): string | null {
  const first = (contact ?? '').split(';')[0]?.split(' — ')[0]?.replace(/\([^)]*\)/g, '').trim() ?? ''
  return first === '' || /^none\b/i.test(first) ? null : first
}

/** The owner's notes, with the whole `Send via` on top: its secondary destinations live there (D8 step 4). */
function notesOf(entry: PackageEntry): string {
  return [entry.sendVia === null ? '' : `Send via: ${entry.sendVia}`, entry.notes].filter((part) => part !== '').join('\n\n')
}

function artifactsOf(entry: PackageEntry, profileVersion: number): Artifacts {
  return {
    version: 1,
    cv: null,
    pdf: null,
    png: null,
    contactHash: null,
    letter: entry.letter,
    form: entry.form.map((f) => ({ ...f, ok: f.answer.trim() !== '' && bracketTokens(f.answer).length === 0 })),
    skills: entry.skills,
    linkedin: entry.linkedin,
    profileVersion,
    rules: [],
    usage: null,
    origin: 'seed',
  }
}

/** The draft of a new entry, not yet written (S6b may move it to `sent` before it is). */
export function draftOf(q: Queries, planned: PlannedEntry, now: Date): { readonly app: Application; readonly contacts: readonly Contact[] } {
  const company = companyByNameKey(q, planned.companyKey)
  if (company === undefined) throw new Error(`seed: company ${planned.companyKey} was not written`)
  const opportunityId = opportunityIdByDedupeKey(q, opportunityKey(planned.companyKey)) ?? insertEntryOpportunity(q, planned, company.id, now)
  const contacts = planned.entry.addresses.map((address) => ensureAddress(q, company.id, company.website, address, now))
  const primary = planned.entry.addresses.findIndex((address) => address.primary)
  const app = newApplication(
    {
      id: uuidv7(),
      opportunityId,
      companyId: company.id,
      channel: planned.entry.channel,
      target: { ...planned.entry.target, contactId: contacts[primary]?.id ?? null, contactName: contactNameOf(planned.entry.contact) },
      cvBase: planned.entry.cvBase,
      holdUntil: planned.config.holdUntil ?? null,
      notes: notesOf(planned.entry),
      test: false,
    },
    now,
  )
  return { app: { ...app, version: 1 }, contacts }
}

function insertEntryOpportunity(q: Queries, planned: PlannedEntry, companyId: string, now: Date): string {
  const opportunity = entryOpportunity(planned.entry, companyId)
  insertOpportunity(q, opportunity, opportunityKey(planned.companyKey), IMPORTED, now)
  return opportunity.id
}

/** Writes the application with its `imported` event and version 1 of its artifacts. */
export function insertImported(q: Queries, planned: PlannedEntry, app: Application, profileVersion: number, now: Date): void {
  insertApplication(q, app, { seedKey: planned.seedKey }, { kind: 'imported', data: { seedKey: planned.seedKey } }, now)
  insertArtifacts(q, app.id, artifactsOf(planned.entry, profileVersion), now)
}

/** Every new company, then every new entry as a `draft`. Answers how many companies were made. */
export function writeCompanies(q: Queries, companies: readonly PlannedCompany[], profileVersion: number, now: Date): number {
  return companies.filter((planned) => ensureCompany(q, planned, profileVersion, now)).length
}

/** A new entry: `draft`, or `sent` when it carries a valid «Sent by hand» (S6b, T-A19). */
export function writeEntry(q: Queries, planned: PlannedEntry, profileVersion: number, now: Date): CreatedApplication {
  const { app: draft, contacts } = draftOf(q, planned, now)
  const at = planned.byHand?.at ?? null
  const app = at === null ? draft : valueOrThrow(sentByHand(draft, at, now))
  insertImported(q, planned, app, profileVersion, now)
  if (at !== null) recordSent(q, app, at, now)
  const checkContactIds = contacts.filter((c) => c.address !== null && c.address.status !== 'checking' && isStaleCheck(c.address, now)).map((c) => c.id)
  return { planned, app, checkContactIds }
}

/** A draft always takes T-A19; if it did not, the table changed under this file: abort the tx. */
function valueOrThrow<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`seed: ${result.error.reason}`)
  return result.value
}
