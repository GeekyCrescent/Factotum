/**
 * The transitions of a mockup (design D2): HERE AND NOWHERE ELSE, pure, `(mockup, event, now) →
 * Result<Mockup>`. They never touch their input and never do I/O; the facade runs them inside the
 * store's queue and does the files around them.
 *
 * - `abandonRun` puts the stage back where it was before the run: `ready`, or `waiting` with
 *   `pendingComment` if it was a redo (criteria 15, 29).
 * - `stallRun` does not remove the run: it marks it `stalled`, and a submission of a stalled run is
 *   accepted all the same (criterion 17). «Retry» is `abandonRun` + `startRun`.
 * - A redo is `decide(redo)` then `startRun` with the comment, in one change (D6).
 */

import { RUN_SPECS, STAGES } from './stages.ts'
import { STAGE_IDS, type Decision, type InputRef, type Mockup, type Result, type Run, type StageId, type StageOption, type Step } from './types.ts'
import { INPUTS_MAX, type DecisionInput } from './shape.ts'

export interface NewMockupInput {
  readonly id: string
  readonly name: string
  readonly client: string
  readonly project: string
  readonly vaultDir: string
  readonly workDir: string
  readonly buildSiteId: string | null
}

export interface StartInput {
  readonly kind: StageId
  readonly runId: string
  readonly siteId: string
  readonly redo?: { readonly comment: string }
}

export interface AcceptInput {
  readonly sessionId: string
  readonly summary: string
  readonly options?: readonly StageOption[]
  /** What a publishing run handed in (D3, check 5), kept on the mockup for the gate and the gallery. */
  readonly previewUrl?: string
  readonly prodUrl?: string
}

const conflict = <T>(reason: string): Result<T> => ({ ok: false, error: { code: 'conflict', reason } })
const notFound = <T>(reason: string): Result<T> => ({ ok: false, error: { code: 'not-found', reason } })
const invalid = <T>(field: string, reason: string): Result<T> => ({ ok: false, error: { code: 'invalid', field, reason } })
const ok = (value: Mockup): Result<Mockup> => ({ ok: true, value })

/** `step` without the keys in `drop`: `exactOptionalPropertyTypes` forbids writing `undefined`. */
function without(step: Step, ...drop: readonly (keyof Step)[]): Step {
  return Object.fromEntries(Object.entries(step).filter(([key]) => !drop.includes(key as keyof Step))) as unknown as Step
}

function put(m: Mockup, id: StageId, step: Step, now: Date): Mockup {
  return { ...m, stages: { ...m.stages, [id]: step }, updatedAt: now.toISOString() }
}

export function newMockup(input: NewMockupInput, now: Date): Mockup {
  const locked: Step = { status: 'locked', version: 0, history: [] }
  const at = now.toISOString()
  return {
    ...input,
    createdAt: at,
    updatedAt: at,
    stages: { brief: { ...locked, status: 'ready' }, concepts: locked, plan: locked, build: locked, deliver: locked },
    changes: [],
    inputs: [],
    urls: {},
    status: 'open',
  }
}

/** The stage that holds the run with this id, if any. */
export function findRun(m: Mockup, runId: string): { readonly stage: StageId; readonly step: Step; readonly run: Run } | undefined {
  for (const stage of STAGE_IDS) {
    const step = m.stages[stage]
    if (step.run?.id === runId) return { stage, step, run: step.run }
  }
  return undefined
}

/** Any run alive in the mockup: one at a time (criterion 19). */
export function liveRun(m: Mockup): Run | undefined {
  return STAGE_IDS.map((id) => m.stages[id].run).find((run) => run !== undefined)
}

export function startRun(m: Mockup, input: StartInput, now: Date): Result<Mockup> {
  if (m.status === 'archived') return conflict('this mockup is archived')
  const live = liveRun(m)
  if (live !== undefined) return conflict(`the ${live.kind} stage already has a run`)
  const step = m.stages[input.kind]
  const isRedo = input.redo !== undefined
  if (isRedo && (step.status !== 'waiting' || step.version === 0)) return conflict(`there is nothing of ${input.kind} to redo`)
  if (!isRedo && step.status !== 'ready') return conflict(`${input.kind} is ${step.status}, not ready to start`)
  const run: Run = {
    id: input.runId,
    kind: input.kind,
    siteId: input.siteId,
    startedAt: now.toISOString(),
    ...(input.redo === undefined ? {} : { redo: { comment: input.redo.comment, fromVersion: step.version } }),
  }
  return ok(put(m, input.kind, { ...without(step, 'pendingComment'), status: 'running', run }, now))
}

export function linkSession(m: Mockup, runId: string, sessionId: string, now: Date): Result<Mockup> {
  const found = findRun(m, runId)
  if (found === undefined) return notFound('there is no such run')
  if (found.run.sessionId === sessionId) return ok(m)
  if (found.run.sessionId !== undefined) return conflict('that run is linked to another session')
  return ok(put(m, found.stage, { ...found.step, run: { ...found.run, sessionId } }, now))
}

export function abandonRun(m: Mockup, runId: string, now: Date): Result<Mockup> {
  const found = findRun(m, runId)
  if (found === undefined) return notFound('there is no such run')
  const rest = without(found.step, 'run')
  const back: Step =
    found.run.redo === undefined ? { ...rest, status: 'ready' } : { ...rest, status: 'waiting', pendingComment: found.run.redo.comment }
  return ok(put(m, found.stage, back, now))
}

export function stallRun(m: Mockup, runId: string, now: Date): Result<Mockup> {
  const found = findRun(m, runId)
  if (found === undefined) return notFound('there is no such run')
  if (found.step.status === 'stalled') return ok(m)
  return ok(put(m, found.stage, { ...found.step, status: 'stalled' }, now))
}

export function acceptSubmit(m: Mockup, runId: string, input: AcceptInput, now: Date): Result<Mockup> {
  const found = findRun(m, runId)
  if (found === undefined) return notFound('there is no such run')
  if (found.run.sessionId !== undefined && found.run.sessionId !== input.sessionId) return conflict('that run belongs to another session')
  const spec = STAGES[found.stage]
  const rest = without(found.step, 'run', 'pendingComment', 'options', 'chosen')
  const step: Step = {
    ...rest,
    status: spec.gate === null ? 'done' : 'waiting',
    version: found.step.version + 1,
    summary: input.summary,
    ...(input.options === undefined ? {} : { options: input.options }),
  }
  return ok(put(withUrls(m, input), found.stage, step, now))
}

function withUrls(m: Mockup, input: AcceptInput): Mockup {
  if (input.previewUrl === undefined && input.prodUrl === undefined) return m
  return {
    ...m,
    urls: { ...m.urls, ...(input.previewUrl === undefined ? {} : { preview: input.previewUrl }), ...(input.prodUrl === undefined ? {} : { prod: input.prodUrl }) },
  }
}

export function decide(m: Mockup, input: DecisionInput, now: Date): Result<Mockup> {
  const step = m.stages[input.step]
  const gate = RUN_SPECS[input.step].gate
  if (step.status !== 'waiting') return conflict(`${input.step} is ${step.status}, not waiting on you`)
  const decision: Decision = {
    at: now.toISOString(),
    action: input.action,
    version: step.version,
    ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
    ...(input.comment === undefined ? {} : { comment: input.comment }),
  }
  const history = [...step.history, decision]

  if (input.action === 'redo') {
    if (input.comment === undefined) return invalid('comment', 'a redo needs a comment')
    return ok(put(m, input.step, { ...step, history }, now))
  }
  if (input.action !== gate) return invalid('action', `${input.step} is answered with ${gate ?? 'nothing'}`)
  if (input.action === 'choose' && !(step.options ?? []).some((option) => option.id === input.optionId)) {
    return invalid('optionId', 'choose one of the options the stage offered')
  }
  const closed: Step = {
    ...without(step, 'pendingComment'),
    status: 'done',
    history,
    ...(input.action === 'choose' && input.optionId !== undefined ? { chosen: input.optionId } : {}),
  }
  const done = put(m, input.step, closed, now)
  const next = STAGES[input.step].next
  if (next === null || done.stages[next].status !== 'locked') return ok(done)
  return ok(put(done, next, { ...done.stages[next], status: 'ready' }, now))
}

/** The work-dir's project in `sessions`, or why `sessions` refused it (D7, criterion 7). */
export function setBuildSite(m: Mockup, site: { readonly siteId: string } | { readonly refused: string }, now: Date): Result<Mockup> {
  const { buildRefused: _dropped, ...rest } = m
  if ('siteId' in site) return ok({ ...rest, buildSiteId: site.siteId, updatedAt: now.toISOString() })
  return ok({ ...rest, buildSiteId: null, buildRefused: site.refused, updatedAt: now.toISOString() })
}

/** Inputs are closed while a stage runs (criterion 12), and capped. */
export function canAddInput(m: Mockup): Result<Mockup> {
  const live = liveRun(m)
  if (live !== undefined) return conflict(`the ${live.kind} stage is running; add inputs when it is done`)
  if (m.inputs.length >= INPUTS_MAX) return conflict(`a mockup takes at most ${INPUTS_MAX} inputs`)
  return ok(m)
}

export function addInput(m: Mockup, input: InputRef, now: Date): Result<Mockup> {
  const allowed = canAddInput(m)
  if (!allowed.ok) return allowed
  return ok({ ...m, inputs: [...m.inputs, input], updatedAt: now.toISOString() })
}

export function archive(m: Mockup, now: Date): Result<Mockup> {
  if (liveRun(m) !== undefined) return conflict('a stage is running; abandon it first')
  return ok({ ...m, status: 'archived', updatedAt: now.toISOString() })
}
