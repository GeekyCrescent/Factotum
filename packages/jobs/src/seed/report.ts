/**
 * The import report (`ImportReport`, design D8 «El informe»): what the dry run shows the owner before
 * anything is written, and what the real import answers. Pure: built from the seed and the plan.
 */

import type { Channel } from '../types.ts'
import type { KitLeftover } from './kit.ts'
import { bracketTokens } from './markdown.ts'
import type { PackageEntry, Skills } from './package.ts'
import type { Plan, PlannedEntry } from './plan.ts'
import type { Seed } from './source.ts'

export interface FileReport {
  readonly file: string
  readonly entries: number
  readonly channels: Readonly<Record<Channel, number>>
  /** Entries not imported before (by `seed_key`). */
  readonly new: number
  readonly existing: number
  readonly holdUntil: string | null
  readonly byHand: boolean
}

export interface EntryRef {
  readonly file: string
  readonly n: number
}

export type PlaceholderPlace = 'to' | 'subject' | 'letter' | 'form' | 'linkedin'

export interface ImportReport {
  readonly dryRun: boolean
  /** The real import refuses without `identity.phone`; the dry run says it here, on top. */
  readonly blocked: 'missing-phone' | null
  readonly companies: {
    readonly read: number
    /** Made by this import (or that it would make, in a dry run). */
    readonly created: number
    /** `industry` hints at health but the company is not in the curated list (v4, B7). */
    readonly suggestedHealth: readonly string[]
  }
  readonly files: readonly FileReport[]
  readonly missing: readonly (EntryRef & { readonly missing: readonly string[] })[]
  /** Entries whose company the companies file does not have: one is made with the entry's name. */
  readonly unmatched: readonly (EntryRef & { readonly company: string })[]
  readonly placeholders: readonly (EntryRef & { readonly where: PlaceholderPlace; readonly token: string })[]
  readonly skills: readonly (EntryRef & { readonly skills: Skills })[]
  readonly kitRefs: readonly (EntryRef & { readonly question: string; readonly section: number; readonly matched: string | null; readonly ambiguous: boolean })[]
  /** Addresses that enter `verified`, and the `Send via` clause that says so. */
  readonly verified: readonly (EntryRef & { readonly email: string; readonly evidence: string })[]
  readonly kit: { readonly leftovers: readonly KitLeftover[]; readonly templateWarnings: readonly string[] }
}

const ref = (planned: PlannedEntry): EntryRef => ({ file: planned.file, n: planned.entry.n })

function placeholdersOf(entry: PackageEntry): readonly { readonly where: PlaceholderPlace; readonly token: string }[] {
  const places: readonly (readonly [PlaceholderPlace, string | null])[] = [
    ['to', entry.target.to],
    ['subject', entry.letter?.subject ?? null],
    ['letter', entry.letter?.body ?? null],
    ...entry.form.map((f) => ['form', f.answer] as const),
    ['linkedin', entry.linkedin],
  ]
  return places.flatMap(([where, text]) => bracketTokens(text ?? '').map((token) => ({ where, token })))
}

const NO_CHANNELS: Readonly<Record<Channel, number>> = { email: 0, form: 0, platform: 0, linkedin: 0 }

function fileReports(seed: Seed, plan: Plan): readonly FileReport[] {
  return seed.packages.map(({ name, config, parsed }) => {
    const planned = plan.entries.filter((p) => p.file === name)
    const channels = parsed.entries.reduce((sum, e) => ({ ...sum, [e.channel]: sum[e.channel] + 1 }), NO_CHANNELS)
    const existing = planned.filter((p) => p.existing !== undefined).length
    return {
      file: name,
      entries: parsed.entries.length,
      channels,
      new: planned.length - existing,
      existing,
      holdUntil: config.holdUntil ?? null,
      byHand: config.byHand === true,
    }
  })
}

export function buildReport(seed: Seed, plan: Plan, flags: { readonly dryRun: boolean; readonly blocked: ImportReport['blocked'] }): ImportReport {
  const entries = plan.entries
  return {
    ...flags,
    companies: {
      read: seed.companies.length,
      created: plan.companies.filter((c) => !c.exists).length,
      suggestedHealth: seed.companies.filter(({ company }) => company.healthSource === 'guessed').map(({ company }) => company.name),
    },
    files: fileReports(seed, plan),
    missing: entries.filter((p) => p.entry.missing.length > 0).map((p) => ({ ...ref(p), missing: p.entry.missing })),
    unmatched: entries.filter((p) => !p.matched).map((p) => ({ ...ref(p), company: p.entry.company })),
    placeholders: entries.flatMap((p) => placeholdersOf(p.entry).map((found) => ({ ...ref(p), ...found }))),
    skills: entries.flatMap((p) => (p.entry.skills === null ? [] : [{ ...ref(p), skills: p.entry.skills }])),
    kitRefs: entries.flatMap((p) => p.entry.kitRefs.map((k) => ({ ...ref(p), question: k.question, section: k.section, matched: k.matched, ambiguous: k.ambiguous }))),
    verified: entries.flatMap((p) =>
      p.entry.addresses.flatMap((a) => (a.status === 'verified' && a.evidence !== null ? [{ ...ref(p), email: a.email, evidence: a.evidence }] : [])),
    ),
    kit: { leftovers: seed.kit.leftovers, templateWarnings: seed.templateWarnings },
  }
}
