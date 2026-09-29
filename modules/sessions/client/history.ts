/**
 * The drawer's history: what waits on the owner, what runs, then every project with its newest
 * conversations, each named by its title or else the first line of its prompt, and a search over
 * what is loaded (spec 2026-09-29, D9). Pure, so every rule has a test; no DOM (guardrail 11).
 *
 * BUILT FROM THE PROJECTS, not from a page of sessions: `GET projects` gives each project its newest
 * few and its total, so a project with a hundred conversations shows eight and "Show more", and one
 * whose folder is missing shows none (criterion 25).
 */

import type { Color, ProjectStatus, ProjectView, SessionState, SessionSummary } from '../types.ts'
import { clip } from './format.ts'

export const UNTITLED = 'Untitled'
const TITLE_CHARS = 60

/** Per session id that waits on the owner: the site the notice carried, and what it asks for. */
export type Waiting = ReadonlyMap<string, { readonly site: string | undefined; readonly detail: string }>

export interface Entry {
  readonly id: string
  /** The project's id. */
  readonly site: string
  /** What the owner calls the project: its name, else its id. */
  readonly siteLabel: string
  readonly color: Color | undefined
  readonly title: string
  readonly startedAt: string | undefined
  readonly state: SessionState
  /** What it asks for, only when it waits on the owner. */
  readonly detail: string | undefined
}

export interface ProjectInfo {
  readonly id: string
  readonly color: Color | undefined
  readonly status: ProjectStatus
  readonly reason: string | undefined
  /** More conversations than are loaded: "Show more". */
  readonly hasMore: boolean
}

export interface Group {
  readonly key: string
  readonly label: string
  readonly entries: readonly Entry[]
  /** Set on a project's group only. */
  readonly project?: ProjectInfo
}

export function titleOf(prompt: string | undefined): string {
  const line = (prompt ?? '')
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '')
  return line === undefined ? UNTITLED : clip(line, TITLE_CHARS)
}

/** The owner's title when there is one (D5), else the first line of the prompt. */
export function nameOf(session: Pick<SessionSummary, 'title' | 'prompt'>): string {
  return session.title === undefined ? titleOf(session.prompt) : clip(session.title, TITLE_CHARS)
}

export function history(
  projects: readonly ProjectView[],
  more: ReadonlyMap<string, readonly SessionSummary[]>,
  waiting: Waiting,
  query: string,
): readonly Group[] {
  const byId = new Map(projects.map((p) => [p.id, p]))
  const loaded = new Map<string, SessionSummary>()
  for (const project of projects) {
    for (const session of [...project.sessions, ...(more.get(project.id) ?? [])]) loaded.set(session.id, session)
  }
  const newest = [...loaded.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const entryOf = (session: SessionSummary, detail: string | undefined = undefined): Entry => {
    const project = byId.get(session.siteId)
    return {
      id: session.id,
      site: session.siteId,
      siteLabel: project?.name ?? session.siteId,
      color: project?.color,
      title: nameOf(session),
      startedAt: session.startedAt,
      state: session.state,
      detail,
    }
  }

  const needs = [...waiting].map(([id, w]): Entry => {
    const session = loaded.get(id)
    if (session !== undefined) return { ...entryOf(session, w.detail), state: 'running' }
    const site = w.site ?? id.slice(0, 8)
    const project = byId.get(site)
    const label = project?.name ?? site
    return { id, site, siteLabel: label, color: project?.color, title: label, startedAt: undefined, state: 'running', detail: w.detail }
  })
  const free = newest.filter((s) => !waiting.has(s.id))
  const running = free.filter((s) => s.state === 'running').map((s) => entryOf(s))

  const groups: Group[] = [
    { key: 'needs', label: 'Needs you', entries: needs },
    { key: 'running', label: 'Running', entries: running },
    ...projects.map((project): Group => {
      const ids = new Set([...project.sessions, ...(more.get(project.id) ?? [])].map((s) => s.id))
      return {
        key: `project:${project.id}`,
        label: project.name ?? project.id,
        entries: free.filter((s) => s.siteId === project.id && s.state !== 'running').map((s) => entryOf(s)),
        project: {
          id: project.id,
          color: project.color,
          status: project.status,
          reason: project.reason,
          hasMore: project.status === 'ok' && project.total > ids.size,
        },
      }
    }),
  ]

  const wanted = query.trim().toLowerCase()
  if (wanted === '') return groups.filter((group) => group.entries.length > 0 || group.project !== undefined)
  return groups
    .map((group) => ({ ...group, entries: group.entries.filter((e) => matches(e, wanted)) }))
    .filter((group) => group.entries.length > 0)
}

function matches(entry: Entry, wanted: string): boolean {
  return [entry.title, entry.site, entry.siteLabel].some((field) => field.toLowerCase().includes(wanted))
}
