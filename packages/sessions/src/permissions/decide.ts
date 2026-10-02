/**
 * The decision itself. PURE: no I/O, no clock, no network.
 *
 * Pure because it is the one function in the project whose answer must be the same
 * every time it is asked, and because a decision that could fail in the middle is a
 * decision that has to have a fallback, and the fallback is the hole.
 *
 * IT RETURNS `ask` ONLY WHEN `canAsk` SAYS SOMEONE CAN BE REACHED. `ask` means "freeze the
 * session and wait for a human", and ADR-0006 refused to produce it until push existed —
 * because an ask nobody can see is a state a session only leaves by timing out. Push exists
 * now (ADR-0008, ADR-0009), and this is the day that ADR described: the type did not change,
 * only which of its members get produced.
 *
 * `canAsk` IS A BOOLEAN, AND THAT IS WHAT KEEPS THIS PURE. The caller has already asked whether
 * anyone is subscribed; here it is input, like `cwd`. The WAIT for the human lives in the
 * engine, never here — the same input still gives the same answer, with no clock and no I/O.
 *
 * Ask and deny carry the same reason, so an ask that nobody answers reads exactly like the deny
 * this gate gave before.
 */

import { BACKGROUND_REDIRECT, isBackgroundBash } from '../services/shape.ts'
import { insideSite, resolveAgainst, type Site } from '../sites.ts'
import type { Decision } from './payload.ts'

export interface DecideInput {
  readonly toolName: string
  readonly toolInput: unknown
  /** The session's working directory, as the CLI reports it. Not the daemon's. */
  readonly cwd: string
  readonly site: Site
  /**
   * Directories writable from EVERY site, declared once in the config.
   *
   * A session has exactly one site, and that is what makes the boundary readable. But
   * one directory is legitimately shared — a notes vault is the case this was built
   * for — and without this the only way to express "three agents, all writing there"
   * is one site big enough to contain everything, which is ONE lock and therefore one
   * agent at a time.
   *
   * THEY ARE NOT SITES. Nothing launches into them, nothing locks them, and two agents
   * writing the same file in one is not prevented by anything. That is the trade the
   * owner makes by declaring one.
   */
  readonly shared?: readonly Site[]
  /**
   * Whether anyone can be asked — `notify.canReach()`, resolved by the caller. REQUIRED: the gate
   * must never ask by omission.
   */
  readonly canAsk: boolean
}

export interface DecisionResult {
  readonly decision: Decision
  readonly reason: string
  /**
   * A deny the log does not record (spec 2026-10-02-servicios-en-segundo-plano, D9; criterion 13): the
   * redirect of a background `Bash` is the agent being pointed elsewhere, not a boundary it hit.
   */
  readonly quiet?: true
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
  // BEFORE the boundary, and ALWAYS deny, never ask: the CLI kills a background Bash when the turn ends
  // (requirements §0.1), so the only useful answer is where to go instead. Nothing for the owner to decide.
  if (isBackgroundBash(input.toolName, input.toolInput)) {
    return { decision: 'deny', reason: BACKGROUND_REDIRECT, quiet: true }
  }

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

  if (insideSite(input.site, target)) {
    return { decision: 'allow', reason: 'writes where it belongs' }
  }

  const shared = input.shared ?? []
  if (shared.some((path) => insideSite(path, target))) {
    return { decision: 'allow', reason: 'writes into a shared path' }
  }

  // The message names the WHOLE boundary, or it sends someone to check half of it.
  // With none declared it is byte for byte what it always was: the common case does
  // not pay for the rare one.
  const also = shared.length === 0 ? '' : ` or ${shared.map((path) => path.path).join(', ')}`
  return { decision: input.canAsk ? 'ask' : 'deny', reason: `writes outside ${input.site.id}${also}: ${target}` }
}
