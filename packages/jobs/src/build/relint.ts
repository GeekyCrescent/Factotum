/**
 * Re-lint of what is not sent (design D6 «Re-lint»; tasks L4): the linter of L1 run again over the
 * store, with the profile of the moment, in the `tx` that changed it.
 *
 * WHAT IT TOUCHES: applications `in-review`/`ready` and follow-ups `draft`/`ready`. `draft` and
 * `generating` are skipped always (their lint runs when the CV comes back, D5 step 8), and so are
 * `rewriting` and `approved`: a re-lint can never take to `ready` something without a printed CV.
 *
 * WHAT IT REPLACES: only the linter's warnings. The found ones (`unsupported-claim`, `cv-overflow`,
 * `ad-closed`, `requirement-gap`) stay with their `overridden`, and an «I checked it» of a warning the
 * linter still gives (an `external-link` still there) is carried — `relintedWarnings` of `state.ts`.
 *
 * NO CLAUDE AND NO CHROMIUM INSIDE THE `tx`. The one thing a re-lint asks for is a reprint, for each
 * application that GAINED `cv-stale`; it is named in the report and the caller enqueues it AFTER the
 * `tx` (`saveProfileRelinting`, the hook `enqueueReprint` — a no-op until H5c connects it).
 *
 * A ROW IT CANNOT LINT IS SKIPPED, NEVER FATAL (`relintUnsent`): with the vault offline the master CV
 * cannot be read, and the owner must still be able to edit the profile. The row keeps its warnings,
 * the save logs it and answers how many were `skipped`. `relintOne` (one row, a caller about it) fails.
 *
 * THE SAME LINTER IS THE QUEUE'S GUARD (G4, `QueueDeps.lint`/`relintOne`): what comes back late is
 * linted, or re-linted, by this file too.
 */

import type { Logger } from '@factotum/core'

import type { LintFn, LintTarget, RelintFn } from '../ai/queue.ts'
import { saveProfile } from '../profile.ts'
import { saveRule } from '../rules.ts'
import { appTransition, followupTransition } from '../state.ts'
import type { Db, Queries } from '../store/db.ts'
import {
  applicationsByState,
  companyRecord,
  genRequestsOf,
  getApplication,
  getArtifacts,
  getCompany,
  getFollowup,
  getOpportunity,
  latestProfileVersion,
  reviewFollowups,
  saveApplication,
  saveFollowup,
} from '../store/repo.ts'
import { fail, ok, type Application, type Artifacts, type Followup, type ProfileVersion, type Result, type Rule, type Warning } from '../types.ts'
import { lint, lintFollowup, type LintContext } from './lint.ts'

export interface LinterDeps {
  /** `cv-maestro.md`, whole, read at each lint: the unknown-number rule's source (L2). */
  readonly master: () => Result<string>
  /** Whether the printed CV is on disk; `existsSync` in production. */
  readonly pdfExists: (path: string) => boolean
}

/** An entity the re-lint could not lint (its context is missing): left as it was. */
export interface SkippedRelint {
  readonly kind: 'application' | 'followup'
  readonly id: string
  readonly reason: string
}

export interface RelintReport {
  /** Entities whose state or warnings changed (one `relinted` event each). */
  readonly relinted: number
  /** Applications that GAINED `cv-stale`: one reprint each, after the `tx`. */
  readonly reprint: readonly string[]
  /**
   * Entities whose lint context could not be read — the master CV with the vault offline, an
   * opportunity or company gone. Their warnings stay as they were; the save never fails for them.
   */
  readonly skipped: readonly SkippedRelint[]
}

export interface Linter {
  /** The queue's `lint` (G4). Throws when the master CV cannot be read: the return is then a failed attempt. */
  readonly lint: LintFn
  /** One entity, in the caller's `tx` (the queue's guard, `decide`). */
  readonly relintOne: RelintFn
  /** Everything unsent, in the caller's `tx` (`saveProfile`, `saveRule`); a row it cannot lint is skipped. */
  readonly relintUnsent: (q: Queries, now: Date) => Result<RelintReport>
}

const APP_STATES: readonly Application['state'][] = ['in-review', 'ready']
const FOLLOWUP_STATES: readonly Followup['state'][] = ['draft', 'ready']
const PENDING: ReadonlySet<string> = new Set(['queued', 'running'])

/** The version an application has before any generation: nothing to send. */
const EMPTY: Omit<Artifacts, 'version' | 'profileVersion'> = {
  cv: null,
  pdf: null,
  png: null,
  contactHash: null,
  letter: null,
  form: [],
  skills: null,
  linkedin: null,
  rules: [],
  usage: null,
  origin: 'generated',
}

/** One entity's re-lint: whether it changed, whether it gained `cv-stale`, or why it was not linted. */
interface Outcome {
  readonly changed: boolean
  readonly staleGained: boolean
  /** Why its lint context could not be read; null when it was linted. */
  readonly skipped: string | null
}

const UNCHANGED: Outcome = { changed: false, staleGained: false, skipped: null }
const skippedFor = (reason: string): Outcome => ({ ...UNCHANGED, skipped: reason })

const codesOf = (warnings: readonly Warning[]): readonly string[] => [...new Set(warnings.filter((w) => w.blocks && w.overridden === null).map((w) => w.code))]
const hasStale = (warnings: readonly Warning[]): boolean => warnings.some((w) => w.code === 'cv-stale')
/** The same warnings, in any order: a re-lint that only reorders them changed nothing. */
const same = (a: readonly Warning[], b: readonly Warning[]): boolean => {
  const keys = (list: readonly Warning[]): string => list.map((w) => JSON.stringify(w)).sort().join('\n')
  return keys(a) === keys(b)
}

export function createLinter(deps: LinterDeps): Linter {
  const pdfOn = (artifacts: Artifacts): boolean => artifacts.pdf !== null && deps.pdfExists(artifacts.pdf)

  /** Everything the linter reads of the store, or why it cannot read it. */
  function contextOf(q: Queries, app: Application, artifacts: Artifacts): Result<LintContext> {
    const master = deps.master()
    if (!master.ok) return master
    const profile = latestProfileVersion(q)
    const opportunity = getOpportunity(q, app.opportunityId)
    const company = getCompany(q, app.companyId)
    if (profile === undefined) return fail('module-error', 'there is no profile to lint with')
    if (opportunity === undefined || company === undefined) return fail('module-error', `application ${app.id} has no opportunity or company`)
    const letterPending = genRequestsOf(q, app.id).some((r) => r.kind === 'letter' && r.state !== null && PENDING.has(r.state))
    return ok({
      master: master.value,
      profile: profile.profile,
      opportunity,
      company: { ...company, record: companyRecord(q, company.id) ?? '' },
      channel: app.channel,
      to: app.target.to,
      pdfExists: pdfOn(artifacts),
      letterPending,
    })
  }

  function lintApplication(q: Queries, app: Application, artifacts: Artifacts): Result<readonly Warning[]> {
    const ctx = contextOf(q, app, artifacts)
    return ctx.ok ? ok(lint(artifacts, ctx.value)) : ctx
  }

  function lintRow(q: Queries, row: Followup, version: Followup['versions'][number]): Result<readonly Warning[]> {
    const profile = latestProfileVersion(q)
    if (profile === undefined) return fail('module-error', 'there is no profile to lint with')
    return ok(lintFollowup(version, { profile: profile.profile, channel: row.channel, to: row.to }))
  }

  const lintTarget: LintFn = (q, target: LintTarget) => {
    const linted = target.kind === 'application' ? lintApplication(q, target.application, target.artifacts) : lintRow(q, target.followup, target.version)
    if (!linted.ok) throw new Error(linted.error.reason)
    return linted.value
  }

  function relintApplication(q: Queries, app: Application, now: Date): Result<Outcome> {
    if (!APP_STATES.includes(app.state)) return ok(UNCHANGED)
    const artifacts = getArtifacts(q, app.id, app.version) ?? { ...EMPTY, version: app.version, profileVersion: 0 }
    const linted = lintApplication(q, app, artifacts)
    if (!linted.ok) return ok(skippedFor(linted.error.reason))
    const moved = appTransition(app, { type: 'relint', pdfExists: pdfOn(artifacts), warnings: linted.value }, now) // T-A5, T-A6
    if (!moved.ok) return moved
    if (moved.value.state === app.state && same(moved.value.warnings, app.warnings)) return ok(UNCHANGED)
    const data = { from: app.state, to: moved.value.state, codes: codesOf(moved.value.warnings) }
    const saved = saveApplication(q, moved.value, { kind: 'relinted', data }, now)
    if (!saved.ok) return saved
    return ok({ changed: true, staleGained: hasStale(moved.value.warnings) && !hasStale(app.warnings), skipped: null })
  }

  function relintFollowup(q: Queries, row: Followup, now: Date): Result<Outcome> {
    if (!FOLLOWUP_STATES.includes(row.state)) return ok(UNCHANGED)
    const version = row.versions.find((v) => v.version === row.version)
    if (version === undefined) return ok(skippedFor(`follow-up ${row.id} has no version ${row.version}`))
    const linted = lintRow(q, row, version)
    if (!linted.ok) return ok(skippedFor(linted.error.reason))
    const moved = followupTransition(row, { type: 'relint', warnings: linted.value }, now) // T-F2
    if (!moved.ok) return moved
    if (moved.value.state === row.state && same(moved.value.warnings, row.warnings)) return ok(UNCHANGED)
    const saved = saveFollowup(q, moved.value, { kind: 'relinted', data: { from: row.state, to: moved.value.state, codes: codesOf(moved.value.warnings) } }, now)
    return saved.ok ? ok({ changed: true, staleGained: false, skipped: null }) : saved
  }

  /** One entity: its caller (the queue's guard, `decide`) is about that row, so a skip is its failure. */
  const settledOne = (done: Result<Outcome>): Result<void> => {
    if (!done.ok) return done
    return done.value.skipped === null ? ok(undefined) : fail('module-error', done.value.skipped)
  }

  const relintOne: RelintFn = (q, entity, now) => {
    if (entity.kind === 'application') {
      const app = getApplication(q, entity.id)
      if (app === undefined) return fail('not-found', 'no such application')
      return settledOne(relintApplication(q, app, now))
    }
    const row = getFollowup(q, entity.id)
    if (row === undefined) return fail('not-found', 'no such follow-up')
    return settledOne(relintFollowup(q, row, now))
  }

  /** A row whose context cannot be read is skipped, never fatal: the save it rides on stands. */
  function relintUnsent(q: Queries, now: Date): Result<RelintReport> {
    let relinted = 0
    const reprint: string[] = []
    const skipped: SkippedRelint[] = []
    for (const app of applicationsByState(q, APP_STATES)) {
      const done = relintApplication(q, app, now)
      if (!done.ok) return done
      if (done.value.skipped !== null) skipped.push({ kind: 'application', id: app.id, reason: done.value.skipped })
      if (done.value.changed) relinted += 1
      if (done.value.staleGained) reprint.push(app.id)
    }
    for (const { id } of reviewFollowups(q, FOLLOWUP_STATES)) {
      const row = getFollowup(q, id)
      const done = row === undefined ? ok(UNCHANGED) : relintFollowup(q, row, now)
      if (!done.ok) return done
      if (done.value.skipped !== null) skipped.push({ kind: 'followup', id, reason: done.value.skipped })
      if (done.value.changed) relinted += 1
    }
    return ok({ relinted, reprint, skipped })
  }

  return { lint: lintTarget, relintOne, relintUnsent }
}

// ── Saving the profile or a rule, with the re-lint in its `tx` (D7 `afterSave`) ─────────────────

export interface RelintSaveDeps {
  readonly now: () => Date
  readonly linter: Linter
  /**
   * D3 «`cv-stale`»: one reprint per application that gained it, AFTER the `tx`. A no-op until H5c
   * connects it to the queue (v4, C3).
   */
  readonly enqueueReprint: (applicationId: string) => void
  readonly log?: Logger | undefined
}

/** What a save answers of its re-lint: how many changed, and how many could not be linted. */
export interface RelintCounts {
  readonly relinted: number
  readonly skipped: number
}

/**
 * After the `tx`: logs each skipped row, then calls the reprint hook for each application; a hook
 * that throws is logged, never fatal.
 */
function afterRelint(report: RelintReport, deps: RelintSaveDeps): RelintCounts {
  for (const skip of report.skipped) deps.log?.warn(`jobs: the re-lint skipped ${skip.kind} ${skip.id} (${skip.reason}); its warnings stay as they were`)
  for (const id of report.reprint) {
    try {
      deps.enqueueReprint(id)
    } catch (error) {
      deps.log?.error(`jobs: the reprint of application ${id} was not queued (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return { relinted: report.relinted, skipped: report.skipped.length }
}

/** `saveProfile` with `relintUnsent` as its `afterSave`: the facade's `saveProfile` (D3, D6). */
export function saveProfileRelinting(db: Db, input: unknown, deps: RelintSaveDeps): Result<ProfileVersion & RelintCounts> {
  const saved = saveProfile(db, input, { now: deps.now, afterSave: (q) => deps.linter.relintUnsent(q, deps.now()) })
  if (!saved.ok) return saved
  return ok({ ...saved.value.saved, ...afterRelint(saved.value.hook, deps) })
}

/** `saveRule` (new, or an edit of `id`) with `relintUnsent` as its `afterSave`. */
export function saveRuleRelinting(
  db: Db,
  input: unknown,
  deps: RelintSaveDeps & { readonly newId?: () => string },
  id?: string,
): Result<Rule & RelintCounts> {
  const ctx = {
    now: deps.now,
    afterSave: (q: Queries) => deps.linter.relintUnsent(q, deps.now()),
    ...(deps.newId === undefined ? {} : { newId: deps.newId }),
  }
  const saved = saveRule(db, input, ctx, id)
  if (!saved.ok) return saved
  return ok({ ...saved.value.saved, ...afterRelint(saved.value.hook, deps) })
}
