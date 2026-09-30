/**
 * The drawer's history: what waits on the owner, what runs, then every project with its newest
 * conversations, each named by its title, the titler's, or else the first line of its prompt, and a search over
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
  /** What it is called on the screen: `nameOf`. */
  readonly title: string
  /**
   * The OWNER'S title alone, apart from what shows (spec 2026-09-30, D12): the rename dialog needs to
   * know whether there is one to clear. `undefined` for a waiting entry with no summary loaded.
   */
  readonly manualTitle: string | undefined
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

/**
 * THREE LAYERS (spec 2026-09-30, D10): the owner's title, else the titler's, else the first line of
 * the prompt. The one place a conversation's name is decided: drawer, header, menu, search, Details.
 */
export function nameOf(session: Pick<SessionSummary, 'title' | 'autoTitle' | 'prompt'>): string {
  if (session.title !== undefined) return clip(session.title, TITLE_CHARS)
  if (session.autoTitle !== undefined) return clip(session.autoTitle, TITLE_CHARS)
  return titleOf(session.prompt)
}

/**
 * How long a new conversation keeps asking for its title (D11): longer than the titler's own
 * deadline (30 s) plus its start. Past it, nothing polls — so an old conversation, which will never
 * be titled, never does.
 */
export const TITLE_WAIT_MS = 45_000
export const TITLE_POLL_MS = 3_000

export function awaitingTitle(session: Pick<SessionSummary, 'title' | 'autoTitle' | 'startedAt'>, now: number): boolean {
  if (session.title !== undefined || session.autoTitle !== undefined) return false
  return now - Date.parse(session.startedAt) < TITLE_WAIT_MS
}

export type RenameAction = { readonly kind: 'save'; readonly title: string } | { readonly kind: 'clear' } | { readonly kind: 'none' }

/**
 * What the rename dialog's button does (D12). EMPTY — spaces included, as the daemon reads it — clears
 * the owner's title when there is one; what the field already said is nothing to save, which is what
 * keeps "open, save" from turning the titler's title into the owner's.
 */
export function renameAction(field: string, initial: string, manualTitle: string | undefined): RenameAction {
  const wanted = field.trim()
  if (wanted === '') return manualTitle === undefined ? { kind: 'none' } : { kind: 'clear' }
  if (wanted === initial.trim()) return { kind: 'none' }
  return { kind: 'save', title: wanted }
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
      manualTitle: session.title,
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
    return { id, site, siteLabel: label, color: project?.color, title: label, manualTitle: undefined, startedAt: undefined, state: 'running', detail: w.detail }
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
