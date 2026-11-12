/**
 * What the mockups screen computes, PURE so `node --test` reaches it (design D9): the order of the
 * gallery, the line of a stage, which actions a stage offers and why one is off, and the warning of
 * criterion 2b.
 */

import { STAGE_IDS, type Mockup, type MockupsSetup, type Run, type StageId, type Step } from '../types.ts'

/** A COPY of the package's `STARTING_OFFER_MS` (criterion 18): «Abandon» after this without a session. */
export const STARTING_OFFER_MS = 2 * 60_000
/** A COPY of the package's `CUT_KINDS`: what this cut launches. The rest shows, with «next cut». */
export const CUT_STAGES: readonly StageId[] = ['brief', 'concepts']

/** A COPY of the gates and the order of the package's stage table (D2). */
const GATES: Readonly<Record<StageId, 'approve' | 'choose' | null>> = { brief: 'approve', concepts: 'choose', plan: 'choose', build: 'approve', deliver: null }
const NEXT: Readonly<Record<StageId, StageId | null>> = { brief: 'concepts', concepts: 'plan', plan: 'build', build: 'deliver', deliver: null }

/** Criteria 27, 28: the stage the screen launches right after approving or choosing `stage`, if this cut launches it. */
export function afterDecision(stage: StageId): StageId | undefined {
  const next = NEXT[stage]
  return next !== null && CUT_STAGES.includes(next) ? next : undefined
}

const RANK = { waiting: 0, stalled: 1, running: 2 } as const

function rankOf(m: Mockup): number {
  const statuses = STAGE_IDS.map((id) => m.stages[id].status)
  for (const [status, rank] of Object.entries(RANK)) if (statuses.includes(status as keyof typeof RANK)) return rank
  return 3
}

/** Criterion 38: waiting on you, stalled, running, the rest; newest change first in each. */
export function galleryOrder(list: readonly Mockup[]): readonly Mockup[] {
  return [...list].sort((a, b) => rankOf(a) - rankOf(b) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
}

/** The stage the mockup is at: the first not done, or deliver. */
export function nowStage(m: Mockup): StageId {
  return STAGE_IDS.find((id) => m.stages[id].status !== 'done') ?? 'deliver'
}

export function statusLine(step: Step): string {
  switch (step.status) {
    case 'waiting':
      return `waiting on you · v${step.version}`
    case 'stalled':
      return 'stalled: the session ended without submitting'
    case 'done':
      return step.version > 0 ? `done · v${step.version}` : 'done'
    default:
      return step.status
  }
}

export interface LaunchContext {
  /** Is `sessions` on the module's host (criterion 41)? */
  readonly sessions: boolean
}

/** The live run of the mockup, if any (criterion 19: one at a time). */
function liveRun(m: Mockup): Run | undefined {
  return STAGE_IDS.map((id) => m.stages[id].run).find((r) => r !== undefined)
}

/** Why a run of `stage` cannot be launched now, or `undefined`. */
export function launchBlocked(m: Mockup, stage: StageId, ctx: LaunchContext): string | undefined {
  if (!ctx.sessions) return 'sessions is not running on this host, so stages cannot be launched'
  const live = liveRun(m)
  if (live !== undefined && live.kind !== stage) return `${live.kind} is running; one stage at a time`
  if ((stage === 'build' || stage === 'deliver') && m.buildSiteId === null) {
    return m.buildRefused === undefined ? 'the work folder is not a sessions project yet' : `no build project: ${m.buildRefused}`
  }
  return undefined
}

export function offersAbandon(run: Run, now: Date): boolean {
  return run.sessionId === undefined && now.getTime() - Date.parse(run.startedAt) >= STARTING_OFFER_MS
}

export interface Action {
  readonly disabled: string | undefined
}

export interface StageActions {
  readonly start?: Action
  readonly retry?: Action
  readonly redo: Action
  /** How this stage's gate is answered (D2). */
  readonly gate: 'approve' | 'choose' | null
  readonly approve: boolean
  /** A choosing gate: pick one of the options (criterion 28). */
  readonly choose: boolean
  readonly abandon: boolean
  /** The linked session, to open it (criterion 17). */
  readonly openSession?: string
}

/** What a stage offers on the screen, and why an action is off. */
export function stageActions(m: Mockup, stage: StageId, ctx: LaunchContext & { readonly now: Date }): StageActions {
  const step = m.stages[stage]
  const inCut = CUT_STAGES.includes(stage)
  const blocked = inCut ? launchBlocked(m, stage, ctx) : 'next cut'
  const run = step.run
  return {
    ...(step.status === 'ready' ? { start: { disabled: blocked } } : {}),
    ...(step.status === 'stalled' ? { retry: { disabled: blocked } } : {}),
    redo: { disabled: step.status === 'waiting' ? blocked : 'only a stage waiting on you can be redone' },
    gate: GATES[stage],
    approve: step.status === 'waiting' && GATES[stage] === 'approve',
    choose: step.status === 'waiting' && GATES[stage] === 'choose',
    abandon: run !== undefined && step.status === 'running' && offersAbandon(run, ctx.now),
    ...(run?.sessionId === undefined ? {} : { openSession: run.sessionId }),
  }
}

/** Criterion 12: inputs are closed while a stage runs. */
export function inputsBlocked(m: Mockup): string | undefined {
  const live = liveRun(m)
  return live === undefined ? undefined : `${live.kind} is running; add inputs when it is done`
}

export interface SessionsProjects {
  readonly projects: readonly { readonly id: string; readonly path: string }[]
  readonly shared: readonly { readonly path: string }[]
}

function within(base: string, target: string, caseInsensitive: boolean): boolean {
  const fold = (value: string): string => (caseInsensitive ? value.toLowerCase() : value).replace(/\/+$/, '')
  const root = fold(base)
  const path = fold(target)
  return path === root || path.startsWith(`${root}/`)
}

export const CROSS_WRITES_WARNING = 'stage sessions will ask before writing outside their project'

/**
 * Criterion 2b, the three checks of D7: the vault stages write in `projectsDir` (inside the docs
 * site); `plan` writes under `workRoot` and `deliver` in `projectsDir` from the other site (a shared
 * folder, unless `crossWritesAllowed`). The screen compares the DECLARED paths: it cannot `realpath`.
 */
export function crossWrites(setup: MockupsSetup, sessions: SessionsProjects, caseInsensitive: boolean): string | undefined {
  const docs = sessions.projects.find((p) => p.id === setup.docsSiteId)
  const inShared = (path: string): boolean => sessions.shared.some((s) => within(s.path, path, caseInsensitive))
  const problems: string[] = []
  if (docs === undefined) problems.push(`there is no sessions project ${setup.docsSiteId}`)
  else if (!within(docs.path, setup.projectsDir, caseInsensitive)) problems.push(`${setup.projectsDir} is outside the project ${setup.docsSiteId}`)
  if (!setup.crossWritesAllowed) {
    if (!inShared(setup.workRoot)) problems.push(`${setup.workRoot} is not a shared folder of sessions`)
    if (!inShared(setup.projectsDir)) problems.push(`${setup.projectsDir} is not a shared folder of sessions`)
  }
  return problems.length === 0 ? undefined : `${CROSS_WRITES_WARNING[0]?.toUpperCase()}${CROSS_WRITES_WARNING.slice(1)}: ${problems.join('; ')}.`
}
