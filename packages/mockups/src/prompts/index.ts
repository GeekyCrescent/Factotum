/** The prompt of each kind of run, and the context it is written from. */

import { previousStage, STAGES } from '../stages.ts'
import type { Mockup, RunKind } from '../types.ts'
import { briefPrompt } from './brief.ts'
import { buildPrompt } from './build.ts'
import { changePrompt } from './change.ts'
import { deliverPrompt } from './deliver.ts'
import type { PromptContext } from './common.ts'
import { conceptsPrompt } from './concepts.ts'
import { planPrompt } from './plan.ts'
import { redeployPrompt } from './redeploy.ts'

export type { PromptContext } from './common.ts'

/**
 * What a run of `kind` is told about its mockup — the choice of the stage before it (crit. 28) and, on
 * the changes track, its change (crit. 36).
 */
export function contextFor(m: Mockup, kind: RunKind, runId: string, redo?: PromptContext['redo'], changeId?: string): PromptContext {
  const before = kind === 'change' || kind === 'redeploy' ? null : previousStage(kind)
  const change = m.changes.find((one) => one.id === changeId)
  const step = before === null ? undefined : m.stages[before]
  const option = step?.chosen === undefined ? undefined : step.options?.find((one) => one.id === step.chosen)
  const file = before === null ? undefined : STAGES[before].chosenIn
  return {
    runId,
    stage: kind,
    project: m.project,
    name: m.name,
    client: m.client,
    vaultDir: m.vaultDir,
    workDir: m.workDir,
    inputs: m.inputs,
    urls: m.urls,
    ...(redo === undefined ? {} : { redo }),
    ...(before === null || option === undefined || file === undefined ? {} : { chosen: { stage: before, file, option } }),
    ...(change === undefined ? {} : { change: { text: change.text, ...(change.previewUrl === undefined ? {} : { previewUrl: change.previewUrl }) } }),
  }
}

export function promptFor(ctx: PromptContext): string {
  switch (ctx.stage) {
    case 'brief':
      return briefPrompt(ctx)
    case 'concepts':
      return conceptsPrompt(ctx)
    case 'plan':
      return planPrompt(ctx)
    case 'build':
      return buildPrompt(ctx)
    case 'deliver':
      return deliverPrompt(ctx)
    case 'change':
      return changePrompt(ctx)
    case 'redeploy':
      return redeployPrompt(ctx)
  }
}
