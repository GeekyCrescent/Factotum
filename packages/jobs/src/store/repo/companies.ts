/** Companies and their contacts (design D3; v4, A2: the address and its state are the contact's). */

import type { Company, Contact } from '../../types.ts'
import { ok, type Result } from '../../types.ts'
import type { Queries, SqlValue } from '../db.ts'
import { appendEvent, withData, type EventSpec } from './events.ts'
import { deepFreeze, flag, json, notFound, text, textOrNull, type Row } from './rows.ts'

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

export const toContact = (row: Row): Contact => {
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
