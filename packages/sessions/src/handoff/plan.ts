/**
 * What would go, and what would not and why (spec 2026-10-07-dos-hosts, D7). PURE: everything git
 * or the peer had to say comes in as data, so the preview and `POST /handoff` decide by the same
 * rules, and every row of D7's table has a test.
 *
 * THE TABLE OF REASONS LIVES IN D7, and this is its one implementation. The order below is the
 * table's: what is not a candidate first (archived, too old, already moved), then a project busy
 * here, then what belongs to the project, then what one candidate session lacks.
 *
 * A CANDIDATE THAT CANNOT GO HOLDS ITS PROJECT BACK (v4.2): the code of a project travels whole, and
 * `cleanSource` would take the work out from under a session left behind. So `entry-missing-on-target`,
 * `cli-transcript-missing`, `too-large` and `too-slow-to-send` keep the whole project here, and say
 * which session and why. `archived` and `too-old` are not candidates and hold nothing.
 */

import type { SessionMeta } from '../store.ts'
import { touchedOf } from '../store.ts'
import { HANDOFF_ASSUMED_MBPS, HANDOFF_FILE_MAX_BYTES, HANDOFF_FILE_MAX_SECONDS, HANDOFF_WINDOW_HOURS } from './constants.ts'
import type { IgnoreDigest } from './git.ts'

/** One project of the TARGET, as its `GET handoff/projects` answers (D7). */
export interface TargetProject {
  readonly key: string
  readonly siteId: string
  readonly clean: boolean
  readonly busy: boolean
  readonly branch: string | undefined
  readonly head: string | undefined
  /** The tips of its local branches. */
  readonly heads: Readonly<Record<string, string>>
  /** The ids of its catalog. */
  readonly entries: readonly string[]
  readonly ignoreDigest: IgnoreDigest
}

export interface PlanSession {
  readonly meta: SessionMeta
  /** The size of every file that would travel for it. Only computed for a candidate. */
  readonly fileBytes: readonly number[]
  readonly transcriptFound: boolean
}

export interface PlanProject {
  readonly siteId: string
  /** `remoteKey(origin)`, or `undefined` when it is not a repo with an `origin` and a commit. */
  readonly key: string | undefined
  /** `undefined` on a detached HEAD. */
  readonly branch: string | undefined
  readonly head: string | undefined
  /** A session running in it, or any holder of its lock. */
  readonly busy: boolean
  readonly localCommits: number
  readonly changedFiles: number
  readonly newUntracked: readonly string[]
  readonly ignoreDigest: IgnoreDigest | undefined
  readonly sessions: readonly PlanSession[]
}

/** What git and the peer said, gathered before planning (`snapshot.ts`). */
export interface PlanFacts {
  /** For a paired project whose target has the source's branch: whether that tip is the source HEAD or an ancestor of it. */
  readonly targetTipIsAncestor: ReadonlyMap<string, boolean>
  /** The sessions the target has whose history here does NOT extend its own (`extendsLog`). */
  readonly diverged: ReadonlySet<string>
}

export interface Limits {
  readonly maxBytes: number
  readonly maxSeconds: number
  readonly mbps: number
}

export const DEFAULT_LIMITS: Limits = { maxBytes: HANDOFF_FILE_MAX_BYTES, maxSeconds: HANDOFF_FILE_MAX_SECONDS, mbps: HANDOFF_ASSUMED_MBPS }

export type SkipReason =
  | 'running'
  | 'project-busy'
  | 'project-not-portable'
  | 'ambiguous-remote'
  | 'no-clone-on-target'
  | 'detached-head'
  | 'target-dirty'
  | 'target-busy'
  | 'target-ahead'
  | 'entry-missing-on-target'
  | 'cli-transcript-missing'
  | 'too-large'
  | 'too-slow-to-send'
  | 'history-diverged'

export interface Skipped {
  readonly siteId: string
  readonly sessionId?: string
  readonly reason: SkipReason
}

export interface PlannedProject {
  readonly siteId: string
  /** The TARGET's id for it: what the peer's routes carry (`<p>`, D13). */
  readonly targetSiteId: string
  readonly branch: string
  readonly head: string
  readonly sessions: readonly string[]
  readonly localCommits: number
  readonly changedFiles: number
  /** Named, so a `.env` nobody ignored is seen before confirming. Never logged (criterion 36). */
  readonly newUntracked: readonly string[]
  readonly bytes: number
  readonly warnings: readonly 'ignore-rules-differ'[]
}

export interface Plan {
  readonly projects: readonly PlannedProject[]
  readonly skipped: readonly Skipped[]
  readonly totals: { readonly archived: number; readonly tooOld: number }
}

/** Not archived, touched within the window, and still this host's. */
export function isCandidate(meta: SessionMeta, now: Date): boolean {
  return meta.archivedAt === undefined && meta.movedTo === undefined && now.getTime() - Date.parse(touchedOf(meta)) < HANDOFF_WINDOW_HOURS * 3_600_000
}

/**
 * The target project a source project pairs with, or why there is none. `ambiguous-remote` when the
 * key is repeated on EITHER host: a wrong pairing would move work into another repo.
 */
export function pairOf(project: PlanProject, sources: readonly PlanProject[], targets: readonly TargetProject[]): TargetProject | SkipReason {
  if (project.key === undefined || project.head === undefined) return 'project-not-portable'
  const sameHere = sources.filter((other) => other.key === project.key).length
  const there = targets.filter((other) => other.key === project.key)
  if (sameHere > 1 || there.length > 1) return 'ambiguous-remote'
  return there[0] ?? 'no-clone-on-target'
}

export function plan(projects: readonly PlanProject[], targets: readonly TargetProject[], facts: PlanFacts, now: Date, limits: Limits = DEFAULT_LIMITS): Plan {
  const planned: PlannedProject[] = []
  const skipped: Skipped[] = []
  let archived = 0
  let tooOld = 0

  for (const project of projects) {
    const candidates: PlanSession[] = []
    for (const one of project.sessions) {
      if (one.meta.movedTo !== undefined) continue
      if (one.meta.archivedAt !== undefined) archived += 1
      else if (!isCandidate(one.meta, now)) tooOld += 1
      else candidates.push(one)
    }
    if (candidates.length === 0) continue
    const outcome = planProject(project, candidates, projects, targets, facts, limits)
    if ('skipped' in outcome) skipped.push(...outcome.skipped)
    else planned.push(outcome.planned)
  }
  return { projects: planned, skipped, totals: { archived, tooOld } }
}

type Outcome = { readonly planned: PlannedProject } | { readonly skipped: readonly Skipped[] }

function planProject(
  project: PlanProject,
  candidates: readonly PlanSession[],
  projects: readonly PlanProject[],
  targets: readonly TargetProject[],
  facts: PlanFacts,
  limits: Limits,
): Outcome {
  const { siteId } = project
  // A project busy here: the running ones say so, and the rest wait for them.
  const running = candidates.filter((one) => one.meta.state === 'running')
  if (running.length > 0 || project.busy) {
    return {
      skipped: candidates.map((one) => ({ siteId, sessionId: one.meta.id, reason: one.meta.state === 'running' ? 'running' : 'project-busy' })),
    }
  }

  const pair = pairOf(project, projects, targets)
  if (typeof pair === 'string') return { skipped: [{ siteId, reason: pair }] }
  const projectReason = projectReasonOf(project, pair, facts)
  if (projectReason !== undefined) return { skipped: [{ siteId, reason: projectReason }] }

  const held = candidates.flatMap((one) => {
    const reason = sessionReasonOf(one, pair, limits)
    return reason === undefined ? [] : [{ siteId, sessionId: one.meta.id, reason }]
  })
  if (held.length > 0) return { skipped: held }
  const diverged = candidates.filter((one) => facts.diverged.has(one.meta.id))
  if (diverged.length > 0) return { skipped: diverged.map((one) => ({ siteId, sessionId: one.meta.id, reason: 'history-diverged' as const })) }

  const differs = pair.ignoreDigest.global !== project.ignoreDigest?.global || pair.ignoreDigest.info !== project.ignoreDigest?.info
  return {
    planned: {
      siteId,
      targetSiteId: pair.siteId,
      branch: project.branch ?? '',
      head: project.head ?? '',
      sessions: candidates.map((one) => one.meta.id),
      localCommits: project.localCommits,
      changedFiles: project.changedFiles,
      newUntracked: project.newUntracked,
      bytes: candidates.reduce((sum, one) => sum + one.fileBytes.reduce((a, b) => a + b, 0), 0),
      warnings: differs ? ['ignore-rules-differ'] : [],
    },
  }
}

function projectReasonOf(project: PlanProject, pair: TargetProject, facts: PlanFacts): SkipReason | undefined {
  if (project.branch === undefined) return 'detached-head'
  if (!pair.clean) return 'target-dirty'
  if (pair.busy) return 'target-busy'
  // A branch the target lacks is never ahead. One it has must be this HEAD or behind it; a tip this
  // host cannot even name is not an ancestor either (D7).
  if (pair.heads[project.branch] !== undefined && facts.targetTipIsAncestor.get(project.siteId) !== true) return 'target-ahead'
  return undefined
}

function sessionReasonOf(one: PlanSession, pair: TargetProject, limits: Limits): SkipReason | undefined {
  if (!pair.entries.includes(one.meta.entryId)) return 'entry-missing-on-target'
  if (!one.transcriptFound) return 'cli-transcript-missing'
  if (one.fileBytes.some((bytes) => bytes > limits.maxBytes)) return 'too-large'
  if (one.fileBytes.some((bytes) => bytes / (limits.mbps * 1_000_000) > limits.maxSeconds)) return 'too-slow-to-send'
  return undefined
}
