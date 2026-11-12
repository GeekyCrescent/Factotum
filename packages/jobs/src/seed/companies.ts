/**
 * The companies file of the seed → companies and opportunities (design D8 step 1). Pure: it receives
 * the parsed JSON and the curated health list, and returns values; nothing here reads a file.
 *
 * The types are shaped after design D3 (`Company`, `Opportunity`) minus what only the store knows
 * (ids, `profileVersion`, `source`, timestamps), so they can move into `types.ts` later.
 */

import { z } from 'zod'

export type OpportunityKind = 'vacancy' | 'outreach' | 'historical'
export type ScoreKey = 'partTime' | 'skills' | 'hiring' | 'visa' | 'access'
export type Score = 1 | 2 | 3 | 4 | 5
export type AtsKind =
  | 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'bamboohr' | 'workday'
  | 'smartrecruiters' | 'breezy' | 'dover' | 'other'

export interface Ats {
  readonly kind: AtsKind
  readonly ref: string
}

/** A contact read from the companies file. Its address (if any) enters `unverified` (T-D1); the import sets it. */
export interface SeedContact {
  readonly name: string | null
  readonly role: string | null
  readonly email: string | null
  readonly sourceUrl: string | null
}

export interface SeedCompany {
  readonly name: string
  readonly nameKey: string
  readonly domain: string | null
  readonly website: string | null
  readonly careersUrl: string | null
  readonly linkedin: string | null
  readonly sector: string | null
  readonly size: { readonly value: string; readonly source: string } | null
  readonly location: string | null
  readonly isHealthEmployer: boolean
  readonly healthSource: 'curated' | 'guessed' | null
  readonly ats: Ats | null
  readonly contacts: readonly SeedContact[]
  /** The text of the fields that may carry figures: the company's allowed source of numbers (D6). */
  readonly record: string
}

export interface SeedOpportunity {
  readonly kind: OpportunityKind
  readonly title: string
  readonly url: string | null
  readonly closesAt: string | null
  readonly startsAt: string | null
  readonly salary: string | null
  readonly requirements: string
  readonly score: number
  readonly breakdown: Readonly<Record<ScoreKey, { readonly score: Score; readonly why: string }>>
}

export interface SeededCompany {
  readonly company: SeedCompany
  readonly opportunity: SeedOpportunity
}

const KIND_OF = {
  'Verified active vacancy': 'vacancy',
  'Proactive outreach': 'outreach',
  'Historical vacancy': 'historical',
} as const satisfies Record<string, OpportunityKind>

/** `build.py:14`, as integers: 30/25/20/15/10 over 5 is 6/5/4/3/2, so the score is exact. */
const WEIGHT_OVER_FIVE = { part_time: 6, skills: 5, growth: 4, visa: 3, access: 2 } as const

const HEALTH_HINT = /health|medical|clinic|hospital|aged.?care/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i
const FIGURE_FIELDS = ['employee_count', 'industry', 'requirements', 'responsibilities', 'fit', 'notes', 'salary'] as const

const nullableText = z.string().nullable().optional().transform((value) => value ?? null)
const score = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])

const rawCompanySchema = z.looseObject({
  company: z.string().min(1),
  role: z.string(),
  opportunity_type: z.enum(Object.keys(KIND_OF) as [keyof typeof KIND_OF, ...(keyof typeof KIND_OF)[]]),
  application_url: nullableText,
  careers_url: nullableText,
  contact: nullableText,
  contact_source: nullableText,
  recruiting_contact: nullableText,
  website: nullableText,
  linkedin: nullableText,
  employee_count: nullableText,
  industry: nullableText,
  location: nullableText,
  salary: nullableText,
  deadline: nullableText,
  start_date: nullableText,
  requirements: nullableText,
  responsibilities: nullableText,
  fit: nullableText,
  notes: nullableText,
  sources: z.array(z.looseObject({ url: nullableText, what: nullableText })).optional().default([]),
  scores: z.object({ part_time: score, skills: score, growth: score, visa: score, access: score }),
})
type RawCompany = z.infer<typeof rawCompanySchema>
type RawScores = RawCompany['scores']

const healthSchema = z.object({ names: z.array(z.string().min(1)) })

/** The curated list, `assets/health-employers.json`. Throws on a file that is not `{ names: string[] }`. */
export function parseHealthEmployers(input: unknown): readonly string[] {
  const parsed = healthSchema.safeParse(input)
  if (!parsed.success) throw new Error(`health-employers.json: ${parsed.error.message}`)
  return parsed.data.names
}

/** Lowercase, no accents, no parentheses, no `pty ltd|inc|limited`, no punctuation (D8 step 1). */
export function nameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(pty\.?\s+ltd|inc|limited)\b\.?/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** `Σ weight·score / 5 · 100` (`build.py:59-60`), 0–100. */
export function scoreOf(scores: RawScores): number {
  return (Object.keys(WEIGHT_OVER_FIVE) as (keyof RawScores)[])
    .reduce((sum, key) => sum + WEIGHT_OVER_FIVE[key] * scores[key], 0)
}

function hostOf(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

const firstSegment = (url: URL, skip = 0): string => url.pathname.split('/').filter(Boolean)[skip] ?? url.hostname
const subdomain = (url: URL): string => url.hostname.split('.')[0] ?? url.hostname

/** The ATS by the host of a URL; a job board (SEEK) or a company site is no ATS. */
export function atsOf(url: string | null): Ats | null {
  if (url === null) return null
  const parsed = hostOf(url)
  if (parsed === null) return null
  const host = parsed.hostname.toLowerCase()
  if (host.endsWith('ashbyhq.com')) return { kind: 'ashby', ref: firstSegment(parsed) }
  if (host.endsWith('greenhouse.io')) return { kind: 'greenhouse', ref: firstSegment(parsed) }
  if (host.endsWith('lever.co')) return { kind: 'lever', ref: firstSegment(parsed) }
  if (host.endsWith('workable.com')) return { kind: 'workable', ref: firstSegment(parsed) }
  if (host.endsWith('bamboohr.com')) return { kind: 'bamboohr', ref: subdomain(parsed) }
  if (host.endsWith('myworkdayjobs.com')) return { kind: 'workday', ref: subdomain(parsed) }
  if (host.endsWith('smartrecruiters.com')) return { kind: 'smartrecruiters', ref: firstSegment(parsed) }
  if (host.endsWith('breezy.hr')) return { kind: 'breezy', ref: subdomain(parsed) }
  if (host === 'app.dover.com') return { kind: 'dover', ref: firstSegment(parsed, 1) }
  if (host.endsWith('dover.com')) return { kind: 'dover', ref: firstSegment(parsed) }
  if (/(^|\.)(rippling\.com|livehire\.com)$/.test(host)) return { kind: 'other', ref: host }
  return null
}

function contactsOf(raw: RawCompany): readonly SeedContact[] {
  const people = (raw.recruiting_contact ?? '')
    .split(';')
    .map((person) => person.trim())
    .filter((person) => person.length > 0)
    .map((person): SeedContact => {
      const [name = person, ...role] = person.split(' — ')
      return { name: name.trim(), role: role.length > 0 ? role.join(' — ').trim() : null, email: null, sourceUrl: raw.contact_source }
    })
  const contact = raw.contact?.trim() ?? ''
  const email: readonly SeedContact[] = EMAIL.test(contact)
    ? [{ name: null, role: null, email: contact, sourceUrl: raw.contact_source }]
    : []
  return [...people, ...email]
}

function sizeOf(count: string | null): SeedCompany['size'] {
  if (count === null) return null
  const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(count)
  return match ? { value: match[1] ?? count, source: match[2] ?? '' } : { value: count, source: '' }
}

function healthOf(raw: RawCompany, curated: ReadonlySet<string>): Pick<SeedCompany, 'isHealthEmployer' | 'healthSource'> {
  if (curated.has(nameKey(raw.company))) return { isHealthEmployer: true, healthSource: 'curated' }
  if (HEALTH_HINT.test(raw.industry ?? '')) return { isHealthEmployer: false, healthSource: 'guessed' }
  return { isHealthEmployer: false, healthSource: null }
}

function recordOf(raw: RawCompany): string {
  const fields = FIGURE_FIELDS.map((field) => raw[field])
  const sources = raw.sources.map((source) => source.what)
  return [...fields, ...sources].filter((text): text is string => typeof text === 'string' && text.length > 0).join('\n')
}

function companyOf(raw: RawCompany, curated: ReadonlySet<string>): SeedCompany {
  const website = raw.website
  const domain = website === null ? null : (hostOf(website)?.hostname.replace(/^www\./, '') ?? null)
  return {
    name: raw.company,
    nameKey: nameKey(raw.company),
    domain,
    website,
    careersUrl: raw.careers_url,
    linkedin: raw.linkedin,
    sector: raw.industry,
    size: sizeOf(raw.employee_count),
    location: raw.location,
    ...healthOf(raw, curated),
    ats: atsOf(raw.application_url) ?? atsOf(raw.careers_url),
    contacts: contactsOf(raw),
    record: recordOf(raw),
  }
}

function opportunityOf(raw: RawCompany): SeedOpportunity {
  const { scores } = raw
  return {
    kind: KIND_OF[raw.opportunity_type],
    title: raw.role,
    url: raw.application_url,
    closesAt: raw.deadline,
    startsAt: raw.start_date,
    salary: raw.salary,
    requirements: raw.requirements ?? '',
    score: scoreOf(scores),
    breakdown: {
      partTime: { score: scores.part_time, why: '' },
      skills: { score: scores.skills, why: '' },
      hiring: { score: scores.growth, why: '' },
      visa: { score: scores.visa, why: '' },
      access: { score: scores.access, why: '' },
    },
  }
}

/**
 * The companies file (a JSON list) → one company and one opportunity per entry. Throws, naming the
 * entry, on a file that is not the expected shape: the import refuses it before writing anything.
 */
export function parseCompanies(input: unknown, healthEmployers: readonly string[]): readonly SeededCompany[] {
  if (!Array.isArray(input)) throw new Error('companies: expected a JSON list')
  const curated = new Set(healthEmployers.map(nameKey))
  return input.map((entry, index) => {
    const parsed = rawCompanySchema.safeParse(entry)
    if (!parsed.success) throw new Error(`companies[${index}]: ${parsed.error.message}`)
    return { company: companyOf(parsed.data, curated), opportunity: opportunityOf(parsed.data) }
  })
}
