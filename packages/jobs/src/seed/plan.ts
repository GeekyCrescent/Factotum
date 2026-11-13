/**
 * What an import would do, decided over a READ of the store (design D8 steps 6–8): which companies are
 * new, which entry matches which company, which entries are already imported (by `seed_key`).
 *
 * The dry run stops here and reports; the real import plans INSIDE its `tx`, so what it decided is
 * what it writes.
 */

import type { Queries } from '../store/db.ts'
import { applicationBySeedKey, companyByNameKey } from '../store/repo.ts'
import type { Application } from '../types.ts'
import { byHandAt, resultFor, type ByHandResult } from './by-hand.ts'
import { nameKey, type SeedCompany, type SeedOpportunity } from './companies.ts'
import type { PackageEntry } from './package.ts'
import type { ReadPackage, Seed, SeedPackage } from './source.ts'

export interface PlannedCompany {
  readonly key: string
  readonly seed: SeedCompany
  /** Null for a company made from an entry that matched none: its opportunity comes from the entry. */
  readonly opportunity: SeedOpportunity | null
  readonly exists: boolean
}

export interface PlannedEntry {
  readonly file: string
  readonly seedKey: string
  readonly config: SeedPackage
  readonly entry: PackageEntry
  readonly companyKey: string
  /** The companies file has this company (design D8 step 6); if not, one is made and reported. */
  readonly matched: boolean
  /** Imported before (same `seed_key`). */
  readonly existing: Application | undefined
  /** `**Sent by hand:**` (S6b): its instant (null when the day is not valid) and what it will do. */
  readonly byHand: PlannedByHand | null
}

export interface PlannedByHand {
  readonly at: string | null
  readonly result: ByHandResult
}

export interface PlanClock {
  readonly now: Date
  readonly timeZone: string
}

export interface Plan {
  readonly companies: readonly PlannedCompany[]
  readonly entries: readonly PlannedEntry[]
}

export const seedKeyOf = (file: string, n: number): string => `${file}#${n}`

/** «Tern Labs (platform / freelance)» → «Tern Labs»: the heading's parenthesis is a note, not the name. */
const nameFromHeading = (heading: string): string => heading.replace(/\s*\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim() || heading

function companyFromEntry(entry: PackageEntry): SeedCompany {
  const name = nameFromHeading(entry.company)
  return {
    name,
    nameKey: nameKey(name),
    domain: null,
    website: null,
    careersUrl: null,
    linkedin: null,
    sector: null,
    size: null,
    location: null,
    isHealthEmployer: false,
    healthSource: null,
    ats: null,
    contacts: [],
    record: '',
  }
}

function byHandOf(raw: string | null, existing: Application | undefined, clock: PlanClock): PlannedByHand | null {
  if (raw === null) return null
  const at = byHandAt(raw, clock.timeZone, clock.now)
  if (at === null) return { at, result: 'invalid' }
  return { at, result: existing === undefined ? 'sent' : resultFor(existing, clock.now) }
}

function plannedEntries(q: Queries, packages: readonly ReadPackage[], known: ReadonlySet<string>, clock: PlanClock): readonly PlannedEntry[] {
  return packages.flatMap(({ config, name, parsed }) =>
    parsed.entries.map((entry) => {
      const seedKey = seedKeyOf(name, entry.n)
      const companyKey = nameKey(entry.company)
      const existing = applicationBySeedKey(q, seedKey)
      return { file: name, seedKey, config, entry, companyKey, matched: known.has(companyKey), existing, byHand: byHandOf(entry.sentByHand, existing, clock) }
    }),
  )
}

export function planImport(q: Queries, seed: Seed, clock: PlanClock): Plan {
  const byKey = new Map<string, PlannedCompany>()
  for (const { company, opportunity } of seed.companies) {
    // A second entry of the companies file with the same key is the same company: the first wins
    // (the report lists it as `duplicate-company`, source.ts).
    if (!byKey.has(company.nameKey)) byKey.set(company.nameKey, { key: company.nameKey, seed: company, opportunity, exists: companyByNameKey(q, company.nameKey) !== undefined })
  }
  const entries = plannedEntries(q, seed.packages, new Set(byKey.keys()), clock)
  for (const planned of entries) {
    if (byKey.has(planned.companyKey)) continue
    const made = companyFromEntry(planned.entry)
    byKey.set(planned.companyKey, { key: planned.companyKey, seed: { ...made, nameKey: planned.companyKey }, opportunity: null, exists: companyByNameKey(q, planned.companyKey) !== undefined })
  }
  return { companies: [...byKey.values()], entries }
}
