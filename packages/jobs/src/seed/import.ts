/**
 * The seed import (design D8; tasks S5–S6b): `importSeed(db, ctx, { dryRun })`.
 *
 * Exported from its own module, NOT through a facade: the facade does not exist yet and C1 wires it
 * (v4, B3).
 *
 * - The dry run reads the vault, plans over a read of the store, and answers the report. It writes
 *   nothing, and it runs without a phone, saying `missing-phone` (or `missing-profile`) on top.
 * - The real import refuses without `identity.phone` BEFORE reading or writing anything (v4, A1):
 *   `missing-profile` when there is no profile at all, `missing-phone` when it has no phone.
 *   Otherwise it plans and writes in ONE `tx`: a `draft` per new entry with version 1 of its
 *   artifacts, an `imported` event each, no lint. After the `tx`, the CVs and the address checks of
 *   what the module sends are queued (`queue.ts`, S6).
 */

import type { Logger } from '@factotum/core'
import type { Db } from '../store/db.ts'
import { latestProfileVersion } from '../store/repo.ts'
import { fail, ok, type Result } from '../types.ts'
import { INVALID_DAY, markImportedSent } from './by-hand.ts'
import { planImport, type Plan, type PlanClock, type PlannedEntry } from './plan.ts'
import { buildReport, type Blocked, type ImportReport } from './report.ts'
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
  /** Where what failed after the `tx` is logged, besides `report.warnings`. */
  readonly log?: Logger | undefined
}

type Readiness = { readonly ok: true; readonly version: number } | { readonly ok: false; readonly blocked: Blocked }

/** The import needs `identity.phone`: no profile at all is `missing-profile`, a profile without it `missing-phone`. */
function readiness(db: Db): Readiness {
  const current = db.read((q) => latestProfileVersion(q))
  if (current === undefined) return { ok: false, blocked: 'missing-profile' }
  if (current.profile.identity.phone.trim() === '') return { ok: false, blocked: 'missing-phone' }
  return { ok: true, version: current.version }
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
  const marked = plan.entries.flatMap((p) => (p.existing !== undefined && p.byHand?.result === 'sent' ? [{ seedKey: p.seedKey, at: p.byHand.at }] : []))
  return marked.flatMap(({ seedKey, at }) => {
    const moved = markImportedSent(db, seedKey, at, now)
    return moved.ok ? [] : [`${seedKey}: not marked sent (${moved.error.code}: ${moved.error.reason})`]
  })
}

export async function importSeed(db: Db, ctx: ImportContext, input: { readonly dryRun: boolean }): Promise<Result<ImportReport>> {
  const ready = readiness(db)
  if (!input.dryRun && !ready.ok) return fail('blocked', ready.blocked)
  const seed = await readSeed(ctx)
  if (!seed.ok) return seed
  const clock = { now: ctx.now(), timeZone: ctx.timeZone }
  if (input.dryRun) {
    const plan = db.read((q) => planImport(q, seed.value, clock))
    const flags = { dryRun: true, blocked: ready.ok ? null : ready.blocked }
    const queued = plannedQueue(db, plan, seed.value.packages, clock.now, clock.timeZone)
    return ok(buildReport(seed.value, plan, flags, { queued, warnings: [] }))
  }
  if (!ready.ok) return fail('blocked', ready.blocked)
  const written = write(db, seed.value, clock, ready.version)
  if (!written.ok) return written
  const markWarnings = markExisting(db, written.value.plan, clock.now)
  for (const warning of markWarnings) ctx.log?.error(`seed: ${warning}`)
  const outcome = queueAfterImport(db, written.value.created, { ...ctx, packages: seed.value.packages, now: clock.now })
  const warnings = [...markWarnings, ...outcome.warnings]
  return ok(buildReport(seed.value, written.value.plan, { dryRun: false, blocked: null }, { ...outcome, warnings }))
}
