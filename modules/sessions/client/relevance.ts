/**
 * Which session to show, which pendings are over, and which ask a session is waiting on. Pure
 * (spec 2026-09-18, criteria 13 and 28); no DOM (guardrail 11).
 *
 * A PENDING is what the shell hands this module: declared here STRUCTURALLY, because a module
 * imports nothing from the shell. For an ask, the engine's notice puts `{ askId, sessionId, siteId,
 * toolName, file }` in `data` and `ask:<sessionId>` in `tag`; on the daemon's own machine the
 * worker keeps it without `askId` (design D12).
 */

import { askTokenFrom, questionsTokenFrom } from '../ask-token.ts'
import type { SessionSummary } from '../types.ts'

export interface Pending {
  readonly tag: string
  readonly until: string
  readonly data: Readonly<Record<string, unknown>>
}

export type Landing = { readonly kind: 'session'; readonly id: string } | { readonly kind: 'new' }

/**
 * A FOLDER REQUEST waiting on the owner (spec 2026-09-29, D3): an ask with no session. Its tag is
 * `grant:<requestId>`; on the daemon's own machine the worker keeps it without `grantId`.
 */
export interface GrantRef {
  readonly tag: string
  readonly requestId: string
  /** The capability. Absent where this device keeps no tokens: approve from the phone. */
  readonly grantId?: string
  readonly name: string | undefined
}

export function grantOf(pending: Pending): GrantRef | undefined {
  const requestId = pending.data['requestId']
  if (pending.data['kind'] !== 'grant' || typeof requestId !== 'string') return undefined
  const grantId = pending.data['grantId']
  const name = pending.data['name']
  return {
    tag: pending.tag,
    requestId,
    ...(typeof grantId === 'string' ? { grantId } : {}),
    name: typeof name === 'string' ? name : undefined,
  }
}

/**
 * The first pending that is about a SESSION — what the strip shows. Never `pending[0]`: a folder
 * request has no session, and taking it would hide the strip of an ask behind it (criterion 22).
 */
export function firstWithSession(pending: readonly Pending[]): Pending | undefined {
  return pending.find((p) => sessionOf(p) !== undefined)
}

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

/** Pendings that are NOT a permission ask, though they may carry a session: questions, folder requests. */
const NOT_AN_ASK: ReadonlySet<unknown> = new Set(['questions', 'grant'])

/** The ask a session is waiting on: its pending if there is one, else the token the page loaded with. */
export function askFor(sessionId: string, pending: readonly Pending[], search: string): AskRef | undefined {
  // A batch of questions has a session too: without this it would open the permission panel with no
  // token (spec 2026-10-01-preguntas-con-opciones, criterion 32).
  const own = pending.find((p) => sessionOf(p) === sessionId && !NOT_AN_ASK.has(p.data['kind']))
  if (own !== undefined) {
    const text = (key: string) => (typeof own.data[key] === 'string' ? { [key]: own.data[key] as string } : {})
    return { tag: own.tag, sessionId, ...text('askId'), ...text('siteId'), ...text('toolName'), ...text('file') }
  }
  const token = askTokenFrom(search)
  return token === undefined ? undefined : { tag: `ask:${sessionId}`, askId: token, sessionId }
}

// --- questions (spec 2026-10-01-preguntas-con-opciones, D10) ---------------------

/** A batch of questions a session is waiting on. Its tag is `questions:<sessionId>:<batch>`. */
export interface QuestionsRef {
  readonly tag: string
  readonly sessionId: string
  /** The batch's PUBLIC id, the one in the log. Authorises nothing. */
  readonly batch: string
  /** How many questions, when the pending says. A batch known only from the URL does not. */
  readonly count: number | undefined
  /** The capability. Absent where this device keeps no tokens and the URL did not bring it. */
  readonly token?: string
}

export function questionsOf(pending: Pending): QuestionsRef | undefined {
  const sessionId = sessionOf(pending)
  const batch = pending.data['batch']
  if (pending.data['kind'] !== 'questions' || sessionId === undefined || typeof batch !== 'string') return undefined
  const count = pending.data['count']
  const token = pending.data['questionsId']
  return {
    tag: pending.tag,
    sessionId,
    batch,
    count: typeof count === 'number' ? count : undefined,
    ...(typeof token === 'string' ? { token } : {}),
  }
}

const questionsTag = (sessionId: string, batch: string): string => `questions:${sessionId}:${batch}`

/**
 * Every batch the session is waiting on, the soonest deadline first.
 *
 * THE URL'S TOKEN IS MERGED INTO ITS PENDING, not ranked against it. On the daemon's own machine the
 * worker drops the token from the kept pending, so "the pending first" (as `askFor` does) would let a
 * pending without a token hide the token the notification brought, and the Mac could not answer
 * (criterion 34). The `batch` in the URL says which pending it is (criterion 40).
 */
export function questionsFor(sessionId: string, pending: readonly Pending[], search: string): readonly QuestionsRef[] {
  const own = [...pending]
    .filter((p) => p.data['kind'] === 'questions' && sessionOf(p) === sessionId)
    .sort((a, b) => (a.until < b.until ? -1 : a.until > b.until ? 1 : 0))
    .map(questionsOf)
    .filter((ref): ref is QuestionsRef => ref !== undefined)
  const url = questionsTokenFrom(search)
  if (url === undefined) return own
  const tag = questionsTag(sessionId, url.batch)
  if (own.some((ref) => ref.tag === tag)) return own.map((ref) => (ref.tag === tag ? { ...ref, token: url.token } : ref))
  return [...own, { tag, sessionId, batch: url.batch, count: undefined, token: url.token }]
}
