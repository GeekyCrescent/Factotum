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

function plannedEntries(q: Queries, packages: readonly ReadPackage[], known: ReadonlySet<string>): readonly PlannedEntry[] {
  return packages.flatMap(({ config, name, parsed }) =>
    parsed.entries.map((entry) => {
      const seedKey = seedKeyOf(name, entry.n)
      const companyKey = nameKey(entry.company)
      return { file: name, seedKey, config, entry, companyKey, matched: known.has(companyKey), existing: applicationBySeedKey(q, seedKey) }
    }),
  )
}

export function planImport(q: Queries, seed: Seed): Plan {
  const byKey = new Map<string, PlannedCompany>()
  for (const { company, opportunity } of seed.companies) {
    // A second entry of the companies file with the same key is the same company: the first wins.
    if (!byKey.has(company.nameKey)) byKey.set(company.nameKey, { key: company.nameKey, seed: company, opportunity, exists: companyByNameKey(q, company.nameKey) !== undefined })
  }
  const entries = plannedEntries(q, seed.packages, new Set(byKey.keys()))
  for (const planned of entries) {
    if (byKey.has(planned.companyKey)) continue
    const made = companyFromEntry(planned.entry)
    byKey.set(planned.companyKey, { key: planned.companyKey, seed: { ...made, nameKey: planned.companyKey }, opportunity: null, exists: companyByNameKey(q, planned.companyKey) !== undefined })
  }
  return { companies: [...byKey.values()], entries }
}
