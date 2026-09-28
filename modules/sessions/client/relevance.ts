/**
 * Which session to show, which pendings are over, and which ask a session is waiting on. Pure
 * (spec 2026-09-18, criteria 13 and 28); no DOM (guardrail 11).
 *
 * A PENDING is what the shell hands this module: declared here STRUCTURALLY, because a module
 * imports nothing from the shell. For an ask, the engine's notice puts `{ askId, sessionId, siteId,
 * toolName, file }` in `data` and `ask:<sessionId>` in `tag`; on the daemon's own machine the
 * worker keeps it without `askId` (design D12).
 */

import { askTokenFrom } from '../ask-token.ts'
import type { SessionSummary } from '../types.ts'

export interface Pending {
  readonly tag: string
  readonly until: string
  readonly data: Readonly<Record<string, unknown>>
}

export type Landing = { readonly kind: 'session'; readonly id: string } | { readonly kind: 'new' }

/** The session a pending is about, when its data says. */
export function sessionOf(pending: Pending): string | undefined {
  const id = pending.data['sessionId']
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** `/m/sessions` with nothing after it: a live pending, else the newest running, else the newest. */
export function pickRelevant(pending: readonly Pending[], sessions: readonly SessionSummary[]): Landing {
  const waiting = pending.map(sessionOf).find((id) => id !== undefined)
  if (waiting !== undefined) return { kind: 'session', id: waiting }
  const newest = (list: readonly SessionSummary[]) =>
    list.reduce<SessionSummary | undefined>((best, s) => (best === undefined || s.startedAt > best.startedAt ? s : best), undefined)
  const pick = newest(sessions.filter((s) => s.state === 'running')) ?? newest(sessions)
  return pick === undefined ? { kind: 'new' } : { kind: 'session', id: pick.id }
}

/** The tags of pendings whose session this page shows as no longer running. */
export function resolvedBy(pending: readonly Pending[], sessions: readonly SessionSummary[]): readonly string[] {
  const over = new Set(sessions.filter((s) => s.state !== 'running').map((s) => s.id))
  return pending.filter((p) => {
    const id = sessionOf(p)
    return id !== undefined && over.has(id)
  }).map((p) => p.tag)
}

export interface AskRef {
  readonly tag: string
  readonly sessionId: string
  /** The capability. Absent when this device keeps no tokens: answer from the notification. */
  readonly askId?: string
  readonly siteId?: string
  readonly toolName?: string
  readonly file?: string
}

/** The ask a session is waiting on: its pending if there is one, else the token the page loaded with. */
export function askFor(sessionId: string, pending: readonly Pending[], search: string): AskRef | undefined {
  const own = pending.find((p) => sessionOf(p) === sessionId)
  if (own !== undefined) {
    const text = (key: string) => (typeof own.data[key] === 'string' ? { [key]: own.data[key] as string } : {})
    return { tag: own.tag, sessionId, ...text('askId'), ...text('siteId'), ...text('toolName'), ...text('file') }
  }
  const token = askTokenFrom(search)
  return token === undefined ? undefined : { tag: `ask:${sessionId}`, askId: token, sessionId }
}
