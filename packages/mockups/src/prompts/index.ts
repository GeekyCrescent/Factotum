/**
 * The prompt of each kind of run, and the context it is written from. `null`: a stage of a later
 * block (tasks.md), which the facade answers with `not-yet` before it gets here.
 */

import { previousStage, STAGES } from '../stages.ts'
import type { Mockup, StageId } from '../types.ts'
import { briefPrompt } from './brief.ts'
import type { PromptContext } from './common.ts'
import { conceptsPrompt } from './concepts.ts'
import { planPrompt } from './plan.ts'

export type { PromptContext } from './common.ts'

/** What a run of `kind` is told about its mockup — and the choice of the stage before it (crit. 28). */
export function contextFor(m: Mockup, kind: StageId, runId: string, redo?: PromptContext['redo']): PromptContext {
  const before = previousStage(kind)
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
    ...(redo === undefined ? {} : { redo }),
    ...(before === null || option === undefined || file === undefined ? {} : { chosen: { stage: before, file, option } }),
  }
}

export function promptFor(ctx: PromptContext): string | null {
  switch (ctx.stage) {
    case 'brief':
      return briefPrompt(ctx)
    case 'concepts':
      return conceptsPrompt(ctx)
    case 'plan':
      return planPrompt(ctx)
    default:
      return null
  }
}
