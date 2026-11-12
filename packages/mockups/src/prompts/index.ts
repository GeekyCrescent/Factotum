/**
 * The prompt of each kind of run. `null`: a stage of a later cut (tasks.md), which the facade answers
 * with `not-yet` before it gets here.
 */

import { briefPrompt } from './brief.ts'
import type { PromptContext } from './common.ts'

export type { PromptContext } from './common.ts'

export function promptFor(ctx: PromptContext): string | null {
  switch (ctx.stage) {
    case 'brief':
      return briefPrompt(ctx)
    default:
      return null
  }
}
