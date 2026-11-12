/**
 * The transitions of a mockup (design D2): HERE AND NOWHERE ELSE, pure, `(mockup, event, now) →
 * Result<Mockup>`. They never touch their input and never do I/O; the facade runs them inside the
 * store's queue and does the files around them.
 *
 * - `abandonRun` puts the step back where it was before the run: `ready`, or `waiting` with
 *   `pendingComment` if it was a redo (criteria 15, 29); a redeploy, back to `approved` (crit. 36).
 * - `stallRun` does not remove the run: it marks it `stalled`, and a submission of a stalled run is
 *   accepted all the same (criterion 17). «Retry» is `abandonRun` + `startRun`.
 * - A redo is `decide(redo)` then `startRun` with the comment, in one change (D6).
 *
 * A run lives in a STAGE or in a CHANGE of the changes track (D2), and one at a time in the whole
 * mockup (criterion 19): `findRun` and `liveRun` look in both.
 */

import { RUN_SPECS, STAGES } from './stages.ts'
import { STAGE_IDS, type Change, type Decision, type InputRef, type Mockup, type Result, type Run, type RunKind, type StageId, type StageOption, type Step } from './types.ts'
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
  readonly kind: RunKind
  readonly runId: string
  readonly siteId: string
  /** A run of the changes track names its change. */
  readonly changeId?: string
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

export interface ChangeDecisionInput {
  readonly changeId: string
  readonly action: DecisionInput['action']
  readonly comment?: string
}

/** Where a run is: a stage, or a change of the changes track. */
export type FoundRun =
  | { readonly stage: StageId; readonly change?: undefined; readonly step: Step; readonly run: Run }
  | { readonly stage?: undefined; readonly change: Change; readonly step: Change; readonly run: Run }

const conflict = <T>(reason: string): Result<T> => ({ ok: false, error: { code: 'conflict', reason } })
const notFound = <T>(reason: string): Result<T> => ({ ok: false, error: { code: 'not-found', reason } })
const invalid = <T>(field: string, reason: string): Result<T> => ({ ok: false, error: { code: 'invalid', field, reason } })
const ok = (value: Mockup): Result<Mockup> => ({ ok: true, value })

/** `step` without the keys in `drop`: `exactOptionalPropertyTypes` forbids writing `undefined`. */
function without<S extends Step>(step: S, ...drop: readonly (keyof Step)[]): S {
  return Object.fromEntries(Object.entries(step).filter(([key]) => !drop.includes(key as keyof Step))) as unknown as S
}

function put(m: Mockup, id: StageId, step: Step, now: Date): Mockup {
  return { ...m, stages: { ...m.stages, [id]: step }, updatedAt: now.toISOString() }
}

function putChange(m: Mockup, change: Change, now: Date): Mockup {
  return { ...m, changes: m.changes.map((one) => (one.id === change.id ? change : one)), updatedAt: now.toISOString() }
}

/** An edit that keeps what the step is: a stage stays a stage, a change a change. */
type Edit = <S extends Step>(step: S) => S

/** `found`'s step through `edit`, written back where it was. */
function update(m: Mockup, found: FoundRun, edit: Edit, now: Date): Mockup {
  return found.change === undefined ? put(m, found.stage, edit(found.step), now) : putChange(m, edit(found.change), now)
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

/** Every run of the mockup, where it is: the stages first, then the changes. */
export function runsOf(m: Mockup): readonly FoundRun[] {
  const found: FoundRun[] = []
  for (const stage of STAGE_IDS) {
    const step = m.stages[stage]
    if (step.run !== undefined) found.push({ stage, step, run: step.run })
  }
  for (const change of m.changes) if (change.run !== undefined) found.push({ change, step: change, run: change.run })
  return found
}

/** Where the run with this id is, if anywhere. */
export function findRun(m: Mockup, runId: string): FoundRun | undefined {
  return runsOf(m).find((found) => found.run.id === runId)
}

/** Any run alive in the mockup: one at a time (criterion 19). */
export function liveRun(m: Mockup): Run | undefined {
  return runsOf(m)[0]?.run
}

function newRun(input: StartInput, fromVersion: number, now: Date): Run {
  return {
    id: input.runId,
    kind: input.kind,
    siteId: input.siteId,
    startedAt: now.toISOString(),
    ...(input.redo === undefined ? {} : { redo: { comment: input.redo.comment, fromVersion } }),
  }
}

export function startRun(m: Mockup, input: StartInput, now: Date): Result<Mockup> {
  if (m.status === 'archived') return conflict('this mockup is archived')
  const live = liveRun(m)
  if (live !== undefined) return conflict(`the ${live.kind} stage already has a run`)
  const kind = input.kind
  if (kind === 'change' || kind === 'redeploy') return startChangeRun(m, input, now)
  const step = m.stages[kind]
  const isRedo = input.redo !== undefined
  if (isRedo && (step.status !== 'waiting' || step.version === 0)) return conflict(`there is nothing of ${kind} to redo`)
  if (!isRedo && step.status !== 'ready') return conflict(`${kind} is ${step.status}, not ready to start`)
  return ok(put(m, kind, { ...without(step, 'pendingComment'), status: 'running', run: newRun(input, step.version, now) }, now))
}

/**
 * The changes track (criterion 36): a change runs while its phase is `change`; once approved, only a
 * redeploy — it is never changed again.
 */
function startChangeRun(m: Mockup, input: StartInput, now: Date): Result<Mockup> {
  const change = m.changes.find((one) => one.id === input.changeId)
  if (change === undefined) return notFound('there is no such change')
  const run = newRun(input, change.version, now)
  if (input.kind === 'redeploy') {
    if (change.phase !== 'approved' || change.status !== 'ready' || input.redo !== undefined) return conflict('only an approved change is redeployed')
    return ok(putChange(m, { ...change, phase: 'redeploy', status: 'running', run }, now))
  }
  if (change.phase !== 'change') return conflict('this change was approved: it is redeployed, never changed again')
  const isRedo = input.redo !== undefined
  if (isRedo && (change.status !== 'waiting' || change.version === 0)) return conflict('there is nothing of this change to redo')
  if (!isRedo && change.status !== 'ready') return conflict(`this change is ${change.status}, not ready to start`)
  return ok(putChange(m, { ...without(change, 'pendingComment'), status: 'running', run }, now))
}

export function linkSession(m: Mockup, runId: string, sessionId: string, now: Date): Result<Mockup> {
  const found = findRun(m, runId)
  if (found === undefined) return notFound('there is no such run')
  if (found.run.sessionId === sessionId) return ok(m)
  if (found.run.sessionId !== undefined) return conflict('that run is linked to another session')
  return ok(update(m, found, (step) => ({ ...step, run: { ...found.run, sessionId } }), now))
}

export function abandonRun(m: Mockup, runId: string, now: Date): Result<Mockup> {
  const found = findRun(m, runId)
  if (found === undefined) return notFound('there is no such run')
  // A redeploy that did not finish leaves its change approved, with «Start redeploy» (crit. 36).
  if (found.change !== undefined && found.run.kind === 'redeploy') return ok(putChange(m, { ...without(found.change, 'run'), phase: 'approved', status: 'ready' }, now))
  const redo = found.run.redo
  return ok(update(m, found, (step) => (redo === undefined ? { ...without(step, 'run'), status: 'ready' } : { ...without(step, 'run'), status: 'waiting', pendingComment: redo.comment }), now))
}

export function stallRun(m: Mockup, runId: string, now: Date): Result<Mockup> {
  const found = findRun(m, runId)
  if (found === undefined) return notFound('there is no such run')
  if (found.step.status === 'stalled') return ok(m)
  return ok(update(m, found, (step) => ({ ...step, status: 'stalled' }), now))
}

export function acceptSubmit(m: Mockup, runId: string, input: AcceptInput, now: Date): Result<Mockup> {
  const found = findRun(m, runId)
  if (found === undefined) return notFound('there is no such run')
  if (found.run.sessionId !== undefined && found.run.sessionId !== input.sessionId) return conflict('that run belongs to another session')
  const gate = RUN_SPECS[found.run.kind].gate
  const accepted: Edit = (step) => ({
    ...without(step, 'run', 'pendingComment', 'options', 'chosen'),
    status: gate === null ? 'done' : 'waiting',
    version: step.version + 1,
    summary: input.summary,
    ...(input.options === undefined ? {} : { options: input.options }),
  })
  if (found.change === undefined) {
    // The last stage puts the app in production: the mockup is delivered (criterion 33).
    const handed = withUrls(m, input)
    return ok(update(STAGES[found.stage].next === null ? { ...handed, status: 'delivered' } : handed, found, accepted, now))
  }
  // A change keeps its own preview (the build's stays); a redeploy updates production and closes it.
  const change = accepted(found.change)
  if (found.run.kind === 'redeploy') return ok(putChange({ ...withUrls(m, { ...input, previewUrl: undefined }), status: 'delivered' }, change, now))
  return ok(putChange(m, { ...change, ...(input.previewUrl === undefined ? {} : { previewUrl: input.previewUrl }) }, now))
}

function withUrls(m: Mockup, input: { readonly previewUrl?: string | undefined; readonly prodUrl?: string | undefined }): Mockup {
  if (input.previewUrl === undefined && input.prodUrl === undefined) return m
  return {
    ...m,
    urls: { ...m.urls, ...(input.previewUrl === undefined ? {} : { preview: input.previewUrl }), ...(input.prodUrl === undefined ? {} : { prod: input.prodUrl }) },
  }
}

function decisionOf(input: { readonly action: Decision['action']; readonly optionId?: string; readonly comment?: string }, version: number, now: Date): Decision {
  return {
    at: now.toISOString(),
    action: input.action,
    version,
    ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
    ...(input.comment === undefined ? {} : { comment: input.comment }),
  }
}

export function decide(m: Mockup, input: DecisionInput, now: Date): Result<Mockup> {
  const step = m.stages[input.step]
  const gate = RUN_SPECS[input.step].gate
  if (step.status !== 'waiting') return conflict(`${input.step} is ${step.status}, not waiting on you`)
  const history = [...step.history, decisionOf(input, step.version, now)]

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

/** A change's own gate (criterion 36): approve into `approved`, ready for its redeploy; or a redo. */
export function decideChange(m: Mockup, input: ChangeDecisionInput, now: Date): Result<Mockup> {
  const change = m.changes.find((one) => one.id === input.changeId)
  if (change === undefined) return notFound('there is no such change')
  if (change.status !== 'waiting') return conflict(`this change is ${change.status}, not waiting on you`)
  const history = [...change.history, decisionOf(input, change.version, now)]
  if (input.action === 'redo') {
    if (input.comment === undefined) return invalid('comment', 'a redo needs a comment')
    return ok(putChange(m, { ...change, history }, now))
  }
  if (input.action !== 'approve') return invalid('action', 'a change is answered with approve')
  return ok(putChange(m, { ...without(change, 'pendingComment'), phase: 'approved', status: 'ready', history }, now))
}

/** «Request a change» (criterion 36): only on a delivered mockup, and one open change at a time. */
export function requestChange(m: Mockup, input: { readonly changeId: string; readonly text: string }, now: Date): Result<Mockup> {
  if (m.status === 'archived') return conflict('this mockup is archived')
  if (m.stages.deliver.status !== 'done') return conflict('a change is asked of a delivered mockup; deliver it first')
  if (m.changes.some((one) => one.status !== 'done')) return conflict('one change at a time: the open one is not done yet')
  const change: Change = { id: input.changeId, text: input.text, phase: 'change', status: 'ready', version: 0, history: [] }
  return ok({ ...m, changes: [...m.changes, change], status: 'changing', updatedAt: now.toISOString() })
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
