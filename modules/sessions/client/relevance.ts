/**
 * Which session to show, which pendings are over, and which ask a session is waiting on. Pure
 * (spec 2026-09-18, criteria 13 and 28); no DOM (guardrail 11).
 *
 * A PENDING is what the shell hands this module: declared here STRUCTURALLY, because a module
 * imports nothing from the shell. For an ask, the engine's notice puts `{ askId, sessionId, siteId,
 * toolName, file }` in `data` and `ask:<sessionId>` in `tag`; on the daemon's own machine the
 * worker keeps it without `askId` (design D12).
 *
 * TWO HOSTS (spec 2026-10-07-dos-hosts, design D12): a pending the relay brought from the peer carries
 * the peer's name in `data.host`; none is the serving host's. A session id is a UUIDv7, so the same id
 * on two hosts does not happen — but a pending is still resolved only by the sessions of ITS host.
 */

import { askTokenFrom, questionsTokenFrom } from '../ask-token.ts'
import type { SessionSummary } from '../types.ts'
import type { HostView } from './contract.ts'
import { touchedOf } from './history.ts'
import { hostKey, isUnreachable } from './hosts.ts'

export interface Pending {
  readonly tag: string
  readonly until: string
  readonly data: Readonly<Record<string, unknown>>
}

/** `host`, when there, is where the session lives (`hostKey`: absent for the serving host). */
export type Landing = { readonly kind: 'session'; readonly id: string; readonly host?: string } | { readonly kind: 'new' }

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

/** The host a pending is about, as the relay named it; `undefined` is the serving host. */
export function hostOf(pending: Pending): string | undefined {
  const host = pending.data['host']
  return typeof host === 'string' && host !== '' ? host : undefined
}

/** The pendings of one host (`key` as `hostKey` gives it). The serving host's own name counts as it. */
export function onHost(pending: readonly Pending[], hosts: readonly HostView[], key: string | undefined): readonly Pending[] {
  return pending.filter((p) => hostKey(hostOf(p), hosts) === key)
}

const landing = (id: string, host: string | undefined): Landing => (host === undefined ? { kind: 'session', id } : { kind: 'session', id, host })

/**
 * `/m/sessions` with nothing after it: a live pending, else the running one last written into, else
 * the one last written into — of `sessions`, the page of the screen's host `here`. A pending of a
 * host that is DOWN is skipped: landing there would only show that it does not answer (criterion 10).
 *
 * "NEWEST" IS THE LAST INTERACTION, the same key the drawer is ordered by, so
 * landing lands on the first row of the list and not on something further down it.
 */
export function pickRelevant(
  pending: readonly Pending[],
  sessions: readonly SessionSummary[],
  hosts: readonly HostView[] = [],
  here: string | undefined = undefined,
): Landing {
  for (const p of pending) {
    const id = sessionOf(p)
    const host = hostKey(hostOf(p), hosts)
    if (id !== undefined && !isUnreachable(host, hosts)) return landing(id, host)
  }
  const newest = (list: readonly SessionSummary[]) =>
    list.reduce<SessionSummary | undefined>((best, s) => (best === undefined || touchedOf(s) > touchedOf(best) ? s : best), undefined)
  const pick = newest(sessions.filter((s) => s.state === 'running')) ?? newest(sessions)
  return pick === undefined ? { kind: 'new' } : landing(pick.id, here)
}

/** The tags of the pendings of host `host` whose session `sessions` — that host's page — shows as over. */
export function resolvedBy(
  pending: readonly Pending[],
  sessions: readonly SessionSummary[],
  hosts: readonly HostView[] = [],
  host: string | undefined = undefined,
): readonly string[] {
  const over = new Set(sessions.filter((s) => s.state !== 'running').map((s) => s.id))
  return onHost(pending, hosts, host)
    .filter((p) => {
      const id = sessionOf(p)
      return id !== undefined && over.has(id)
    })
    .map((p) => p.tag)
}

/**
 * The hosts besides the screen's (`here`) that hold a pending, whose pages have to be read to know
 * whether it is over. A host that is down is left out: its pendings wait, and nothing waits on it.
 */
export function otherHosts(pending: readonly Pending[], hosts: readonly HostView[], here: string | undefined): readonly (string | undefined)[] {
  const keys = new Set<string | undefined>()
  for (const p of pending) {
    if (sessionOf(p) === undefined) continue
    const key = hostKey(hostOf(p), hosts)
    if (key !== here && !isUnreachable(key, hosts)) keys.add(key)
  }
  return [...keys]
}

/**
 * Whether landing can decide yet. A pending that names a host needs `GET /hosts` first — to know
 * whether that is this host, and whether it is up; before its first answer the list is empty.
 */
export function landingReady(pending: readonly Pending[], hosts: readonly HostView[]): boolean {
  return hosts.length > 0 || pending.every((p) => hostOf(p) === undefined)
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

/**
 * The batches the LOG says are open, added to what the pendings and the URL already gave — without a
 * token: those are answered from the screen, by session and public id (2026-10-02, the owner's call;
 * answering a question grants nothing). What the pendings or the URL had keeps its token.
 */
export function withLogBatches(
  sessionId: string,
  known: readonly QuestionsRef[],
  open: readonly { readonly id: string; readonly count: number }[],
): readonly QuestionsRef[] {
  const have = new Set(known.map((ref) => ref.batch))
  const added = open
    .filter((batch) => !have.has(batch.id))
    .map((batch) => ({ tag: questionsTag(sessionId, batch.id), sessionId, batch: batch.id, count: batch.count }))
  return [...known, ...added]
}
