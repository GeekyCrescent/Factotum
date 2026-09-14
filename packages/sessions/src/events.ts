/**
 * The four event kinds, and how a line of `events.jsonl` becomes one.
 *
 * THE LOG IS THE SOURCE OF TRUTH AND IT IS NEVER REWRITTEN. Everything else — the
 * state a screen shows, what the cursor returns — is derived from it. That is what
 * makes "close the tab, come back in ten minutes" cost nothing to support.
 *
 * Adding a fifth kind is meant to be cheap: what `parseLine` does not recognise it
 * DROPS, so an old client reading a newer log skips forward instead of falling over.
 */

import { z } from 'zod'
import type { SessionEvent, SessionState } from './types.ts'

export const SESSION_STATES = ['running', 'finished', 'failed', 'cancelled'] as const

export const sessionStateSchema = z.enum(SESSION_STATES)

const base = { seq: z.number().int().min(0), at: z.string().min(1) }

export const sessionEventSchema = z.union([
  z.object({ ...base, kind: z.literal('message'), role: z.enum(['user', 'assistant']), text: z.string() }),
  z.object({ ...base, kind: z.literal('tool'), name: z.string(), input: z.unknown() }),
  z.object({ ...base, kind: z.literal('result'), name: z.string(), ok: z.boolean(), summary: z.string() }),
  z.object({ ...base, kind: z.literal('state'), state: sessionStateSchema, reason: z.string().optional() }),
])

export function serialize(event: SessionEvent): string {
  // `reason: undefined` would round-trip as a missing key anyway; dropping it here
  // keeps the file readable by eye, which is how criterion 11 gets checked.
  return `${JSON.stringify(event, (_key, value: unknown) => (value === undefined ? undefined : value))}\n`
}

/**
 * `undefined` for anything that is not a well-formed event, INCLUDING A TRUNCATED
 * LINE. A daemon killed mid-write leaves half a line behind, and criterion 11 says the
 * half-line is skipped and the log keeps being readable — not that the session becomes
 * unreadable because its last byte arrived late.
 */
export function parseLine(line: string): SessionEvent | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined

  let json: unknown
  try {
    json = JSON.parse(trimmed)
  } catch {
    return undefined
  }

  const parsed = sessionEventSchema.safeParse(json)
  if (!parsed.success) return undefined

  const value = parsed.data
  // `reason` is optional in the schema and REQUIRED-but-nullable in the type, because
  // `exactOptionalPropertyTypes` makes `reason?: string` refuse an explicit undefined
  // and both copies of `types.ts` have to agree without thinking about it.
  return value.kind === 'state' ? { ...value, reason: value.reason ?? undefined } : value
}

/** Reading a whole log: parse every line, keep what is an event, drop what is not. */
export function parseLog(text: string): readonly SessionEvent[] {
  const events: SessionEvent[] = []
  for (const line of text.split('\n')) {
    const event = parseLine(line)
    if (event !== undefined) events.push(event)
  }
  return events
}

/** The last state the log carries, which is the only state anything else derives. */
export function stateFrom(events: readonly SessionEvent[], fallback: SessionState): SessionState {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.kind === 'state') return event.state
  }
  return fallback
}

export function isTerminal(state: SessionState): boolean {
  return state !== 'running'
}
