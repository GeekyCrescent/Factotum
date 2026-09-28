/**
 * The drawer's history: what waits on the owner, what runs, then every project with its sessions,
 * each named by the first line of its prompt, and a search over all of it. Pure, so every rule has
 * a test; no DOM (guardrail 11).
 */

import type { SessionState, SessionSummary } from '../types.ts'
import { clip } from './format.ts'

export const UNTITLED = 'Untitled'
const TITLE_CHARS = 60

/** Per session id that waits on the owner: the site the notice carried, and what it asks for. */
export type Waiting = ReadonlyMap<string, { readonly site: string | undefined; readonly detail: string }>

export interface Entry {
  readonly id: string
  readonly site: string
  readonly title: string
  readonly startedAt: string | undefined
  readonly state: SessionState
  /** What it asks for, only when it waits on the owner. */
  readonly detail: string | undefined
}

export interface Group {
  readonly key: string
  readonly label: string
  readonly entries: readonly Entry[]
}

export function titleOf(prompt: string | undefined): string {
  const line = (prompt ?? '')
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '')
  return line === undefined ? UNTITLED : clip(line, TITLE_CHARS)
}

export function history(sessions: readonly SessionSummary[], waiting: Waiting, query: string): readonly Group[] {
  const known = new Map(sessions.map((s) => [s.id, s]))
  const newest = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))

  const needs = [...waiting].map(([id, w]): Entry => {
    const session = known.get(id)
    const site = session?.siteId ?? w.site ?? id.slice(0, 8)
    return {
      id,
      site,
      title: session === undefined ? site : titleOf(session.prompt),
      startedAt: session?.startedAt,
      state: 'running',
      detail: w.detail,
    }
  })
  const free = newest.filter((s) => !waiting.has(s.id))
  const running = free.filter((s) => s.state === 'running').map(entryOf)

  const bySite = new Map<string, Entry[]>()
  for (const s of free.filter((s) => s.state !== 'running')) bySite.set(s.siteId, [...(bySite.get(s.siteId) ?? []), entryOf(s)])

  const groups: Group[] = [
    { key: 'needs', label: 'Needs you', entries: needs },
    { key: 'running', label: 'Running', entries: running },
    ...[...bySite].map(([site, entries]) => ({ key: `site:${site}`, label: site, entries })),
  ]
  const wanted = query.trim().toLowerCase()
  return groups
    .map((group) => (wanted === '' ? group : { ...group, entries: group.entries.filter((e) => matches(e, wanted)) }))
    .filter((group) => group.entries.length > 0)
}

function entryOf(session: SessionSummary): Entry {
  return {
    id: session.id,
    site: session.siteId,
    title: titleOf(session.prompt),
    startedAt: session.startedAt,
    state: session.state,
    detail: undefined,
  }
}

function matches(entry: Entry, wanted: string): boolean {
  return entry.title.toLowerCase().includes(wanted) || entry.site.toLowerCase().includes(wanted)
}
