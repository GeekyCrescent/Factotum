/**
 * What the CLI posts to the hook, and what it accepts back.
 *
 * Both shapes were MEASURED against CLI 2.1.257 in block A, not copied from a
 * document. What came back carried three fields nothing here asked for —
 * `transcript_path`, `prompt_id` and `effort` — which is precisely why the request
 * schema is LOOSE.
 *
 * A strict schema here fails closed in the wrong direction: the payload stops
 * validating the day the CLI adds a field, every decision becomes a `deny`, and every
 * session becomes unusable over a key nobody reads.
 */

import { z } from 'zod'

/**
 * The five fields that are actually read. `session_id` is the important one: the URL
 * is the same for every session, so this is what attributes a call to the site whose
 * boundary is about to be checked. Guessing instead would mean guessing where somebody
 * is allowed to write.
 */
export const preToolUsePayloadSchema = z.looseObject({
  hook_event_name: z.literal('PreToolUse'),
  session_id: z.string().min(1),
  tool_name: z.string().min(1),
  tool_input: z.unknown(),
  tool_use_id: z.string().min(1),
  cwd: z.string().min(1),
  // NOT read, and deliberately not even typed as meaningful: the CLI reports
  // "default" even for a session launched with `--permission-mode manual`. Measured
  // again in block A against this very payload. Using it for logic would be using a
  // field that lies.
})

export type PreToolUsePayload = z.infer<typeof preToolUsePayloadSchema>

export type Decision = 'allow' | 'deny' | 'ask'

/**
 * The body of the 200 that IS the decision. There is no second channel: a 413, a 500
 * or an unreachable server carry no decision at all, and block A measured what the CLI
 * does with those — it treats them as "not granted" and blocks the tool.
 */
export function decisionBody(decision: Decision, reason: string): {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'PreToolUse'
    readonly permissionDecision: Decision
    readonly permissionDecisionReason: string
  }
} {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }
}

export const denyBody = (reason: string) => decisionBody('deny', reason)
export const allowBody = (reason: string) => decisionBody('allow', reason)
