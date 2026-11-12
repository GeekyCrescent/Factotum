/**
 * After the import's `tx` (design D8 steps 4 and 7; tasks S6): the CV of every application the module
 * will send is queued, and the addresses of those applications go to the checks.
 *
 * WHAT THE MODULE SENDS: entries of a file that is not `byHand` (the fallback line only) and not
 * already `sent`. Of those, the CV is queued now only for files without `holdUntil` (the ads and wave
 * 1: 18 + 25 = 43, v7); wave 2 stays `draft` and the tick queues it at `holdUntil − 7 d` (G5). Its
 * addresses ARE checked now, behind the others.
 *
 * THE TWO SEAMS (injected; neither exists yet in this package):
 *
 * - `enqueueCv(q, applicationId) → Result<void>` — G2a's enqueue. Called in ITS OWN `tx`, one per
 *   application: it writes `gen_requests(applicationId, 'cv')` (and its `work` row) and moves the
 *   application `draft → generating` (T-A1), with its event. A `!ok` rolls that one back; the
 *   application stays `draft` and the report says so. C1 wires it to the queue.
 * - `enqueueSeedChecks(contactIds) → void` — N4's «re-search right after importing». Called ONCE,
 *   outside any `tx`, with the contacts in the order they should be checked (sent-now first, wave 2
 *   behind), and not at all when there are none. Optional: a no-op until C1 wires it.
 */

import type { Db, Queries } from '../store/db.ts'
import type { Result } from '../types.ts'
import type { Plan, PlannedEntry } from './plan.ts'
import type { SeedPackage } from './source.ts'
import type { CreatedApplication } from './write.ts'

export interface QueueSeams {
  readonly enqueueCv: (q: Queries, applicationId: string) => Result<void>
  readonly enqueueSeedChecks?: ((contactIds: readonly string[]) => void) | undefined
}

export interface Queued {
  readonly cv: number
  readonly checks: number
}

export interface QueueOutcome {
  readonly queued: Queued
  readonly warnings: readonly string[]
}

/** The module sends it: not a `byHand` file (and not already `sent`, S6b: callers check the state). */
const sendsIt = (config: SeedPackage): boolean => config.byHand !== true
/** Its CV is queued at import: sent by the module and not held back (wave 2). */
const queuesCvNow = (config: SeedPackage): boolean => sendsIt(config) && config.holdUntil === undefined

const unique = (ids: readonly string[]): readonly string[] => [...new Set(ids)]

/** Sent-now first, held (wave 2) behind: the checks run while the CVs are generated. */
function checkOrder(created: readonly CreatedApplication[]): readonly string[] {
  const checked = created.filter((c) => sendsIt(c.planned.config) && c.app.state === 'draft')
  const now = checked.filter((c) => c.planned.config.holdUntil === undefined)
  const held = checked.filter((c) => c.planned.config.holdUntil !== undefined)
  return unique([...now, ...held].flatMap((c) => c.checkContactIds))
}

export function queueAfterImport(db: Db, created: readonly CreatedApplication[], seams: QueueSeams): QueueOutcome {
  const contactIds = checkOrder(created)
  if (contactIds.length > 0) seams.enqueueSeedChecks?.(contactIds)
  const warnings: string[] = []
  let cv = 0
  for (const c of created.filter((c) => queuesCvNow(c.planned.config) && c.app.state === 'draft')) {
    const queued = db.tx((q) => seams.enqueueCv(q, c.app.id))
    if (queued.ok) cv += 1
    else warnings.push(`${c.planned.seedKey}: the CV was not queued (${queued.error.code}: ${queued.error.reason})`)
  }
  return { queued: { cv, checks: contactIds.length }, warnings }
}

/** What a dry run would queue: the new entries the module sends, and their distinct addresses. */
export function plannedQueue(plan: Plan): Queued {
  const fresh = plan.entries.filter((p) => p.existing === undefined && p.byHand === null && sendsIt(p.config))
  const addresses = (p: PlannedEntry): readonly string[] => p.entry.addresses.map((a) => `${p.companyKey}|${a.email.toLowerCase()}`)
  return { cv: fresh.filter((p) => queuesCvNow(p.config)).length, checks: unique(fresh.flatMap(addresses)).length }
}
