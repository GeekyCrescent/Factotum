/**
 * After the import's `tx` (design D8 steps 4 and 7; tasks S6): the CV of every application the module
 * will send is queued, and the addresses of those applications go to the checks.
 *
 * WHAT THE MODULE SENDS: entries of a file that is not `byHand` (the fallback line only) and not
 * already `sent`. Of those, the CV is queued now for files without `holdUntil` (the ads and wave 1:
 * 18 + 25 = 43, v7), and for a held file (wave 2) once `holdUntil − 7 d` has come in `jobs.timeZone`
 * (G5). Its addresses ARE checked now, behind the others.
 *
 * THE CVs COME FROM THE STATE, not from what this import created: every `draft` of such a file with no
 * `gen_requests(id, 'cv')` row. So a CV the queue refused, or one lost to a crash between the `tx` and
 * here, is queued by the next import.
 *
 * THE TWO SEAMS (injected; neither exists yet in this package):
 *
 * - `enqueueCv(q, applicationId) → Result<void>` — G2a's enqueue. Called in ITS OWN `tx`, one per
 *   application: it writes `gen_requests(applicationId, 'cv')` (and its `work` row) and moves the
 *   application `draft → generating` (T-A1), with its event. A `!ok` rolls that one back; the
 *   application stays `draft`, the report and the log say so, and the next import tries again.
 * - `enqueueSeedChecks(contactIds) → number` — N4's «re-search right after importing». Called ONCE,
 *   outside any `tx`, with the contacts in the order they should be checked (sent-now first, wave 2
 *   behind), and not at all when there are none. It answers how many it queued, which the report
 *   shows. A throw is a warning and a log line: the CVs are queued all the same. Optional: without
 *   it nothing is queued (0) until C1 wires it.
 */

import type { Logger } from '@factotum/core'
import type { Db, Queries } from '../store/db.ts'
import { seedDraftsWithoutCv } from '../store/repo.ts'
import { isCalendarDate } from '../shape.ts'
import type { Result } from '../types.ts'
import { todayIn } from './by-hand.ts'
import type { Plan, PlannedEntry } from './plan.ts'
import type { ReadPackage, SeedPackage } from './source.ts'
import type { CreatedApplication } from './write.ts'

export interface QueueSeams {
  readonly enqueueCv: (q: Queries, applicationId: string) => Result<void>
  /** Answers how many checks it actually queued (a contact already checking is not queued again). */
  readonly enqueueSeedChecks?: ((contactIds: readonly string[]) => number) | undefined
}

/** What the queueing needs besides the seams: the files, the clock, and where failures are logged. */
export interface QueueContext extends QueueSeams {
  readonly packages: readonly ReadPackage[]
  readonly now: Date
  readonly timeZone: string
  readonly log?: Logger | undefined
}

export interface Queued {
  readonly cv: number
  readonly checks: number
}

export interface QueueOutcome {
  readonly queued: Queued
  readonly warnings: readonly string[]
}

const DAY_MS = 24 * 60 * 60 * 1000
/** The CV of a held file is queued this many days before its `holdUntil` (G5). */
const HOLD_LEAD_DAYS = 7

/** The module sends it: not a `byHand` file (and not already `sent`, S6b: callers check the state). */
const sendsIt = (config: SeedPackage): boolean => config.byHand !== true

/** `holdUntil − 7 d`, YYYY-MM-DD; null when `holdUntil` is not a calendar day. */
function queueDay(holdUntil: string): string | null {
  if (!isCalendarDate(holdUntil)) return null
  return new Date(Date.parse(`${holdUntil}T00:00:00Z`) - HOLD_LEAD_DAYS * DAY_MS).toISOString().slice(0, 10)
}

/** Its CV is queued now: sent by the module, and not held, or held to a day at most 7 days away. */
function queuesCvNow(config: SeedPackage, today: string): boolean {
  if (!sendsIt(config)) return false
  if (config.holdUntil === undefined) return true
  const day = queueDay(config.holdUntil)
  return day !== null && day <= today
}

/** The files (by base name, as `seed_key` has them) whose drafts get their CV queued now. */
function cvFiles(packages: readonly ReadPackage[], now: Date, timeZone: string): readonly string[] {
  const today = todayIn(now, timeZone)
  return packages.filter((p) => queuesCvNow(p.config, today)).map((p) => p.name)
}

const unique = (ids: readonly string[]): readonly string[] => [...new Set(ids)]

/** Sent-now first, held (wave 2) behind: the checks run while the CVs are generated. */
function checkOrder(created: readonly CreatedApplication[]): readonly string[] {
  const checked = created.filter((c) => sendsIt(c.planned.config) && c.app.state === 'draft')
  const now = checked.filter((c) => c.planned.config.holdUntil === undefined)
  const held = checked.filter((c) => c.planned.config.holdUntil !== undefined)
  return unique([...now, ...held].flatMap((c) => c.checkContactIds))
}

function queueCvs(db: Db, ctx: QueueContext): { readonly cv: number; readonly warnings: readonly string[] } {
  const drafts = db.read((q) => seedDraftsWithoutCv(q, cvFiles(ctx.packages, ctx.now, ctx.timeZone)))
  const warnings: string[] = []
  let cv = 0
  for (const draft of drafts) {
    const queued = db.tx((q) => ctx.enqueueCv(q, draft.id))
    if (queued.ok) {
      cv += 1
      continue
    }
    const warning = `${draft.seedKey}: the CV was not queued (${queued.error.code}: ${queued.error.reason})`
    ctx.log?.error(`seed: ${warning}`)
    warnings.push(warning)
  }
  return { cv, warnings }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The hook, guarded: it runs after the `tx` committed, so a throw must not undo the answer. */
function queueChecks(created: readonly CreatedApplication[], ctx: QueueContext): { readonly checks: number; readonly warnings: readonly string[] } {
  const contactIds = checkOrder(created)
  if (contactIds.length === 0 || ctx.enqueueSeedChecks === undefined) return { checks: 0, warnings: [] }
  try {
    return { checks: ctx.enqueueSeedChecks(contactIds), warnings: [] }
  } catch (error) {
    const warning = `the address checks were not queued (${messageOf(error)})`
    ctx.log?.error(`seed: ${warning}`)
    return { checks: 0, warnings: [warning] }
  }
}

export function queueAfterImport(db: Db, created: readonly CreatedApplication[], ctx: QueueContext): QueueOutcome {
  const checks = queueChecks(created, ctx)
  const cvs = queueCvs(db, ctx)
  return { queued: { cv: cvs.cv, checks: checks.checks }, warnings: [...checks.warnings, ...cvs.warnings] }
}

/**
 * What a dry run would queue: the CVs of the new entries the module sends now plus the drafts already
 * imported that still have none (as `queueAfterImport` would find them), and the distinct addresses of
 * the new entries.
 */
export function plannedQueue(db: Db, plan: Plan, packages: readonly ReadPackage[], now: Date, timeZone: string): Queued {
  const files = cvFiles(packages, now, timeZone)
  const fresh = plan.entries.filter((p) => p.existing === undefined && p.byHand === null && sendsIt(p.config))
  const markedNow = new Set(plan.entries.filter((p) => p.existing !== undefined && p.byHand?.result === 'sent').map((p) => p.seedKey))
  const waiting = db.read((q) => seedDraftsWithoutCv(q, files)).filter((d) => !markedNow.has(d.seedKey))
  const addresses = (p: PlannedEntry): readonly string[] => p.entry.addresses.map((a) => `${p.companyKey}|${a.email.toLowerCase()}`)
  return { cv: fresh.filter((p) => files.includes(p.file)).length + waiting.length, checks: unique(fresh.flatMap(addresses)).length }
}
