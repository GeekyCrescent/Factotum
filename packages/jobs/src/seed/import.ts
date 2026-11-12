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
import { planImport, type Plan } from './plan.ts'
import { buildReport, type ImportReport } from './report.ts'
import { readSeed, type Seed, type SeedSource } from './source.ts'
import { plannedQueue, queueAfterImport, type QueueSeams } from './queue.ts'
import { writeCompanies, writeDraft, type CreatedApplication } from './write.ts'

export type { ImportReport } from './report.ts'
export type { SeedPackage, SeedVault } from './source.ts'

/** The two injected seams (`enqueueCv` → G2a, `enqueueSeedChecks` → N4) are declared in `queue.ts`. */
export interface ImportContext extends SeedSource, QueueSeams {
  readonly now: () => Date
  /** `jobs.timeZone` (design D13). */
  readonly timeZone: string
}

interface Written {
  readonly created: readonly CreatedApplication[]
}

const hasPhone = (db: Db): { readonly ok: boolean; readonly version: number } => {
  const current = db.read((q) => latestProfileVersion(q))
  return { ok: current !== undefined && current.profile.identity.phone.trim() !== '', version: current?.version ?? 0 }
}

function write(db: Db, seed: Seed, profileVersion: number, now: Date): Result<{ readonly plan: Plan; readonly written: Written }> {
  return db.tx((q) => {
    const plan = planImport(q, seed)
    writeCompanies(q, plan.companies, profileVersion, now)
    const created = plan.entries.filter((p) => p.existing === undefined).map((p) => writeDraft(q, p, profileVersion, now))
    return ok({ plan, written: { created } })
  })
}

export async function importSeed(db: Db, ctx: ImportContext, input: { readonly dryRun: boolean }): Promise<Result<ImportReport>> {
  const phone = hasPhone(db)
  if (!input.dryRun && !phone.ok) return fail('blocked', 'missing-phone')
  const seed = await readSeed(ctx)
  if (!seed.ok) return seed
  if (input.dryRun) {
    const plan = db.read((q) => planImport(q, seed.value))
    const flags = { dryRun: true, blocked: phone.ok ? null : 'missing-phone' } as const
    return ok(buildReport(seed.value, plan, flags, { queued: plannedQueue(plan), warnings: [] }))
  }
  const written = write(db, seed.value, phone.version, ctx.now())
  if (!written.ok) return written
  const outcome = queueAfterImport(db, written.value.written.created, ctx)
  return ok(buildReport(seed.value, written.value.plan, { dryRun: false, blocked: null }, outcome))
}
