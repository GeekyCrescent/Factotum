/**
 * Which skills, commands and agents were used, counted from the logs (spec 2026-10-03-skills-a-mano, D9).
 *
 * THE LOG ALREADY HOLDS IT (§0.8): the owner's `/name` is the text of a user message, an agent's own
 * Skill call is a `Skill` tool event, a subagent is a `started` event. `countSession` is pure: one
 * session in, a list of uses out. The walk over sessions lives in the engine.
 *
 * NO PROMPT TEXT LEAVES THIS FILE. A use is a name, who did it and when; nothing else (guardrail 7).
 */

import { isInvokableName, type Invoke } from './catalog.ts'
import type { SessionIndex } from './index-cache.ts'
import type { SessionMeta, SessionStore } from './store.ts'
import type { Announced, SessionEvent, UsageCount } from './types.ts'

export interface Use {
  readonly name: string
  readonly who: 'owner' | 'agent'
  readonly at: string
}

export interface CountInput {
  readonly meta: SessionMeta
  readonly events: readonly SessionEvent[]
  /** ISO. Only what happened at or after it counts. */
  readonly since: string
  readonly announced: Announced
  /** What a catalog entry launches with, `undefined` for one that is not there or is disabled. */
  readonly invokeOf: (entryId: string) => Invoke | undefined
}

/** The name a user message invokes: `/name rest` → `name`. `undefined` when it is not an invocation. */
function typedName(text: string): string | undefined {
  if (!text.startsWith('/')) return undefined
  const token = text.slice(1).split(/\s/, 1)[0] ?? ''
  return isInvokableName(token) ? token : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export function countSession(input: CountInput): readonly Use[] {
  const { meta, events, since, announced, invokeOf } = input
  const invokable = new Set([...announced.skills, ...announced.commands])
  const agents = new Set(announced.agents)
  const uses: Use[] = []
  const add = (name: string, who: Use['who'], at: string): void => {
    if (at >= since) uses.push({ name, who, at })
  }

  // What the session itself says about how it began: once, at startedAt.
  if (meta.agent !== undefined && agents.has(meta.agent)) add(meta.agent, 'owner', meta.startedAt)
  const entry = invokeOf(meta.entryId)
  if (entry?.kind === 'command' && invokable.has(entry.name)) add(entry.name, 'owner', meta.startedAt)

  for (const event of events) {
    if (event.kind === 'message' && event.role === 'user') {
      // A daemon notice also has role 'user', but never starts with `/`.
      const name = typedName(event.text)
      if (name !== undefined && invokable.has(name)) add(name, 'owner', event.at)
    } else if (event.kind === 'tool' && event.name === 'Skill') {
      const skill = isRecord(event.input) ? event.input['skill'] : undefined
      if (typeof skill === 'string' && invokable.has(skill)) add(skill, 'agent', event.at)
    } else if (event.kind === 'subagent' && event.phase === 'started' && agents.has(event.agent)) {
      add(event.agent, 'agent', event.at)
    }
  }
  return uses
}

const DAY_MS = 24 * 60 * 60 * 1000

export interface UsageDeps {
  readonly index: SessionIndex
  readonly store: SessionStore
  readonly ensureIndex: () => Promise<void>
  readonly announced: () => Announced | undefined
  readonly invokeOf: (entryId: string) => Invoke | undefined
  readonly now: () => Date
}

/**
 * A count for EVERY announced name, zeros included, or `undefined` without a list. The same walk as
 * `search.ts`: the index (deleted sessions are gone from it, archived ones are not), then one log at
 * a time, never all in memory. A session is read only if it was open at some point since `since`.
 */
export async function usageOver(deps: UsageDeps, days: number): Promise<readonly UsageCount[] | undefined> {
  const announced = deps.announced()
  if (announced === undefined) return undefined
  const now = deps.now()
  const since = new Date(now.getTime() - days * DAY_MS).toISOString()

  const tally = new Map<string, { owner: number; agent: number; lastUsedAt: string | undefined }>()
  for (const name of [...announced.skills, ...announced.agents, ...announced.commands]) {
    tally.set(name, { owner: 0, agent: 0, lastUsedAt: undefined })
  }

  await deps.ensureIndex()
  for (const meta of deps.index.all()) {
    if (meta.startedAt < since && (meta.endedAt ?? now.toISOString()) < since) continue
    const page = await deps.store.read(meta.id, 0)
    for (const use of countSession({ meta, events: page.events, since, announced, invokeOf: deps.invokeOf })) {
      const row = tally.get(use.name)
      if (row === undefined) continue
      row[use.who] += 1
      if (row.lastUsedAt === undefined || use.at > row.lastUsedAt) row.lastUsedAt = use.at
    }
  }
  return [...tally].map(([name, row]) => ({ name, ...row }))
}
