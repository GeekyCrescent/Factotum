/**
 * The seed import (design D8; tasks S5–S6b): `importSeed(db, ctx, { dryRun })`.
 *
 * Exported from its own module, NOT through a facade: the facade does not exist yet and C1 wires it
 * (v4, B3).
 *
 * - The dry run reads the vault, plans over a read of the store, and answers the report. It writes
 *   nothing, and it runs without a phone, saying `missing-phone` on top.
 * - The real import refuses without `identity.phone` BEFORE reading or writing anything (v4, A1).
 *   Otherwise it plans and writes in ONE `tx`: a `draft` per new entry with version 1 of its
 *   artifacts, an `imported` event each, no lint. After the `tx`, the CVs and the address checks of
 *   what the module sends are queued (`queue.ts`, S6).
 */

import type { Db } from '../store/db.ts'
import { latestProfileVersion } from '../store/repo.ts'
import { fail, ok, type Result } from '../types.ts'
import { INVALID_DAY, markImportedSent } from './by-hand.ts'
import { planImport, type Plan, type PlanClock, type PlannedEntry } from './plan.ts'
import { buildReport, type ImportReport } from './report.ts'
import { readSeed, type Seed, type SeedSource } from './source.ts'
import { plannedQueue, queueAfterImport, type QueueSeams } from './queue.ts'
import { writeCompanies, writeEntry, type CreatedApplication } from './write.ts'

export type { ImportReport } from './report.ts'
export type { SeedPackage, SeedVault } from './source.ts'

/** The two injected seams (`enqueueCv` → G2a, `enqueueSeedChecks` → N4) are declared in `queue.ts`. */
export interface ImportContext extends SeedSource, QueueSeams {
  readonly now: () => Date
  /** `jobs.timeZone` (design D13). */
  readonly timeZone: string
}

const hasPhone = (db: Db): { readonly ok: boolean; readonly version: number } => {
  const current = db.read((q) => latestProfileVersion(q))
  return { ok: current !== undefined && current.profile.identity.phone.trim() !== '', version: current?.version ?? 0 }
}

/** A «Sent by hand» that is not a past day: the real import writes nothing (D8 step 8). */
const firstInvalid = (plan: Plan): PlannedEntry | undefined => plan.entries.find((p) => p.byHand?.result === 'invalid')

function write(db: Db, seed: Seed, clock: PlanClock, profileVersion: number): Result<{ readonly plan: Plan; readonly created: readonly CreatedApplication[] }> {
  return db.tx((q) => {
    const plan = planImport(q, seed, clock)
    const invalid = firstInvalid(plan)
    if (invalid !== undefined) return fail('invalid', INVALID_DAY, invalid.seedKey)
    writeCompanies(q, plan.companies, profileVersion, clock.now)
    const created = plan.entries.filter((p) => p.existing === undefined).map((p) => writeEntry(q, p, profileVersion, clock.now))
    return ok({ plan, created })
  })
}

/** Entries imported before that now carry the mark: each goes `sent` in its own `tx` (T-A19). */
function markExisting(db: Db, plan: Plan, now: Date): readonly string[] {
  const marked = plan.entries.filter((p) => p.existing !== undefined && p.byHand?.result === 'sent' && p.byHand.at !== null)
  return marked.flatMap((p) => {
    const moved = markImportedSent(db, p.seedKey, p.byHand?.at ?? '', now)
    return moved.ok ? [] : [`${p.seedKey}: not marked sent (${moved.error.code}: ${moved.error.reason})`]
  })
}

export async function importSeed(db: Db, ctx: ImportContext, input: { readonly dryRun: boolean }): Promise<Result<ImportReport>> {
  const phone = hasPhone(db)
  if (!input.dryRun && !phone.ok) return fail('blocked', 'missing-phone')
  const seed = await readSeed(ctx)
  if (!seed.ok) return seed
  const clock = { now: ctx.now(), timeZone: ctx.timeZone }
  if (input.dryRun) {
    const plan = db.read((q) => planImport(q, seed.value, clock))
    const flags = { dryRun: true, blocked: phone.ok ? null : 'missing-phone' } as const
    return ok(buildReport(seed.value, plan, flags, { queued: plannedQueue(plan), warnings: [] }))
  }
  const written = write(db, seed.value, clock, phone.version)
  if (!written.ok) return written
  const markWarnings = markExisting(db, written.value.plan, clock.now)
  const outcome = queueAfterImport(db, written.value.created, ctx)
  const warnings = [...markWarnings, ...outcome.warnings]
  return ok(buildReport(seed.value, written.value.plan, { dryRun: false, blocked: null }, { ...outcome, warnings }))
}
