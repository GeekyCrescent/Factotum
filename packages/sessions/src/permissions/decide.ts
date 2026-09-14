/**
 * The decision itself. PURE: no I/O, no clock, no network.
 *
 * Pure because it is the one function in the project whose answer must be the same
 * every time it is asked, and because a decision that could fail in the middle is a
 * decision that has to have a fallback, and the fallback is the hole.
 *
 * IT NEVER RETURNS `ask`. The type carries three members because that is the CLI's
 * contract, not this project's. `ask` means "freeze the session and wait for a human",
 * and making that usable needs a push notification with buttons, a waiting state, and
 * a timeout that cancels — none of which exist without TLS. So a call that would be
 * `ask` elsewhere is a `deny` WITH ITS REASON here: the agent is told no, says so in
 * its output, and carries on. The day push exists, `ask` starts being produced and
 * this type does not change. (ADR-0006.)
 */

import { insideSite, resolveAgainst, type Site } from '../sites.ts'
import type { Decision } from './payload.ts'

export interface DecideInput {
  readonly toolName: string
  readonly toolInput: unknown
  /** The session's working directory, as the CLI reports it. Not the daemon's. */
  readonly cwd: string
  readonly site: Site
}

export interface DecisionResult {
  readonly decision: Decision
  readonly reason: string
}

/**
 * Only tools that WRITE are checked against the boundary.
 *
 * What needs approval is propagating outside the site, and reading does not propagate.
 * Asking about every read would make the flow unusable, and an alarm that sounds when
 * nothing is wrong does not get read — it gets switched off. Criterion 5.
 *
 * `Bash` IS NOT HERE, and that is the declared hole, not an oversight: checking a path
 * inside a shell command means parsing shell, and parsing shell badly is worse than
 * not parsing it. `echo x > /outside` goes through. Risk 3, open question 6, and it
 * is written in the README rather than hidden.
 */
const WRITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** Where a writing tool says it is going. The three the CLI actually uses. */
const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const

export function isWritingTool(name: string): boolean {
  return WRITING_TOOLS.has(name)
}

export function resolveTarget(toolInput: unknown, cwd: string): string | undefined {
  if (toolInput === null || typeof toolInput !== 'object') return undefined
  const record = toolInput as Record<string, unknown>

  for (const key of PATH_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return resolveAgainst(cwd, value)
  }
  return undefined
}

export function decide(input: DecideInput): DecisionResult {
  if (!isWritingTool(input.toolName)) {
    return { decision: 'allow', reason: 'reading does not propagate' }
  }

  const target = resolveTarget(input.toolInput, input.cwd)
  if (target === undefined) {
    // A writing tool with no destination path is not a write anybody can place. It is
    // allowed because refusing it would refuse a shape this does not understand, and
    // the boundary is about paths.
    return { decision: 'allow', reason: 'no destination path' }
  }

  if (!insideSite(input.site, target)) {
    return { decision: 'deny', reason: `writes outside ${input.site.id}: ${target}` }
  }

  return { decision: 'allow', reason: 'writes where it belongs' }
}
