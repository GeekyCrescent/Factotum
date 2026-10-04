/**
 * The history, as the screens ask for it: lists, one conversation, the projects with their newest
 * conversations, and renaming, archiving and deleting (spec 2026-09-29, D4, D6). Kept apart from
 * `engine.ts`, which runs sessions; everything here reads the index and writes through the store.
 *
 * A CONVERSATION OF A MISSING PROJECT IS NOT READ (criterion 25): not its summary, not its place in
 * a list. A conversation of a REMOVED project is still there to be read and deleted — it is what
 * "Removed projects" lists — and appears in no list and no search.
 */

import type { SessionIndex } from './index-cache.ts'
import { isSessionId } from './id.ts'
import type { SiteTable } from './projects.ts'
import type { RemoveOutcome, SessionMeta, SessionStore } from './store.ts'
import type {
  Page,
  ProjectsPage,
  ProjectView,
  RemovedView,
  RemoveResult,
  SessionEdit,
  SessionPage,
  SessionSummary,
  SummaryResult,
} from './types.ts'

export const PAGE_SIZE = 25

/** How many conversations each project shows before "Show more" (requirements, assumption 16). */
export const RECENT_PER_PROJECT = 8

/** A title is cut here (criterion 30). */
export const TITLE_MAX = 80

export interface HistoryDeps {
  readonly store: SessionStore
  readonly index: SessionIndex
  /** Builds the index if it is not built yet; the same promise every time. */
  readonly ensureIndex: () => Promise<void>
  readonly table: SiteTable
  readonly isLive: (id: string) => boolean
  /**
   * Deletes one conversation AND the uploads its owner sent in it (spec 2026-10-01, D6). The one way
   * a conversation is deleted, so the three doors — here and the two in `folders.ts` — cannot drift.
   */
  readonly removeConversation: (id: string) => Promise<RemoveOutcome>
  readonly now: () => Date
  readonly registryFile: string
  readonly home: string
  readonly canRequest: () => boolean
}

export interface History {
  readonly summaryOf: (meta: SessionMeta) => SessionSummary
  readonly list: (page: Page) => Promise<SessionPage>
  readonly summary: (id: string) => Promise<SummaryResult>
  readonly rename: (id: string, title: string) => Promise<SessionEdit>
  readonly archive: (id: string, archived: boolean) => Promise<SessionEdit>
  readonly remove: (ids: readonly string[]) => Promise<readonly RemoveResult[]>
  readonly projects: () => Promise<ProjectsPage>
  /** Conversations whose project is not registered, by site. Empty while the registry is broken. */
  readonly removed: () => Promise<readonly RemovedView[]>
}

export function summaryOf(meta: SessionMeta): SessionSummary {
  return {
    id: meta.id,
    siteId: meta.siteId,
    entryId: meta.entryId,
    state: meta.state,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    reason: meta.reason,
    turns: meta.turns,
    prompt: meta.prompt,
    agent: meta.agent,
    title: meta.title,
    autoTitle: meta.autoTitle,
    archived: meta.archivedAt !== undefined,
  }
}

export function createHistory(deps: HistoryDeps): History {
  const { store, index, table } = deps

  /** Registered AND there: the only conversations a list or a search may show. */
  const readable = (siteId: string): boolean => table.status(siteId) === 'ok'

  const removed = async (): Promise<readonly RemovedView[]> => {
    await deps.ensureIndex()
    if (table.broken() !== undefined) return []
    const registered = new Set(table.entries().map((entry) => entry.id))
    const counts = new Map<string, number>()
    for (const meta of index.all()) {
      if (!registered.has(meta.siteId)) counts.set(meta.siteId, (counts.get(meta.siteId) ?? 0) + 1)
    }
    return [...counts].map(([siteId, count]) => ({ siteId, count })).sort((a, b) => a.siteId.localeCompare(b.siteId))
  }

  const edit = async (
    id: string,
    change: (meta: SessionMeta) => SessionMeta | 'running',
  ): Promise<SessionEdit> => {
    if (!isSessionId(id)) return { outcome: 'invalid', reason: `"${id}" is not a session id` }
    let refused = false
    const next = await store.patchMeta(id, (current) => {
      const changed = change(current)
      if (changed === 'running') {
        refused = true
        return current
      }
      return changed
    })
    if (next === undefined) return { outcome: 'unknown' }
    return refused ? { outcome: 'running' } : { outcome: 'ok', summary: summaryOf(next) }
  }

  return {
    summaryOf,

    list: async (page) => {
      await deps.ensureIndex()
      const wanted = index
        .all()
        .filter((meta) => (page.site === undefined ? readable(meta.siteId) : meta.siteId === page.site && readable(page.site)))
        .filter((meta) => (meta.archivedAt !== undefined) === page.archived)
      const number = Math.max(0, page.page)
      const from = number * PAGE_SIZE
      return { sessions: wanted.slice(from, from + PAGE_SIZE).map(summaryOf), page: number, hasMore: wanted.length > from + PAGE_SIZE }
    },

    summary: async (id) => {
      if (!isSessionId(id)) return { kind: 'invalid' }
      await deps.ensureIndex()
      const meta = index.get(id) ?? (await store.readMeta(id))
      if (meta === undefined) return { kind: 'unknown' }
      const check = await table.refresh(meta.siteId)
      if (check?.status === 'missing') return { kind: 'site-missing', siteId: meta.siteId }
      const entry = table.entry(meta.siteId)
      return {
        kind: 'ok',
        summary: summaryOf(meta),
        project: entry === undefined ? undefined : { id: entry.id, name: entry.name, color: entry.color },
      }
    },

    // EMPTY CLEARS the owner's title, and the titler's shows again (spec 2026-09-30, D3). It used to
    // be refused: with only the first line behind it, there was nothing to go back to.
    rename: async (id, title) => {
      const trimmed = title.trim()
      return await edit(id, (meta) => ({ ...meta, title: trimmed === '' ? undefined : trimmed.slice(0, TITLE_MAX) }))
    },

    archive: async (id, archived) =>
      await edit(id, (meta) => {
        // Archiving hides it from the drawer; a running one is exactly what must stay in sight.
        if (archived && (meta.state === 'running' || deps.isLive(id))) return 'running'
        return { ...meta, archivedAt: archived ? deps.now().toISOString() : undefined }
      }),

    remove: async (ids) => {
      const results: RemoveResult[] = []
      for (const id of ids) {
        if (!isSessionId(id)) {
          results.push({ id, outcome: 'invalid' })
          continue
        }
        results.push({ id, outcome: await deps.removeConversation(id) })
      }
      return results
    },

    projects: async () => {
      await deps.ensureIndex()
      await table.refreshAll()
      const projects = table.entries().map((entry): ProjectView => {
        const all = index.bySite(entry.id)
        const active = all.filter((meta) => meta.archivedAt === undefined)
        const status = table.status(entry.id) === 'ok' ? 'ok' : 'missing'
        // The newest few, and every running one even when it is older: what is live never hides.
        const recent = active.slice(0, RECENT_PER_PROJECT)
        const running = active.slice(RECENT_PER_PROJECT).filter((meta) => meta.state === 'running')
        return {
          id: entry.id,
          path: table.lastSite(entry.id)?.path ?? entry.path,
          name: entry.name,
          color: entry.color,
          status,
          reason: table.reason(entry.id),
          isRepo: table.lastSite(entry.id)?.isRepo ?? false,
          // A missing project shows no conversations: they are not read (criterion 25).
          sessions: status === 'ok' ? [...recent, ...running].map(summaryOf) : [],
          total: active.length,
          archived: all.length - active.length,
          category: entry.category,
          concurrent: entry.concurrent === true,
        }
      })
      return {
        projects,
        shared: table.sharedViews(),
        removed: await removed(),
        registryError: table.broken(),
        skipped: table.skipped(),
        file: deps.registryFile,
        home: deps.home,
        canRequest: deps.canRequest(),
        categories: table.categories(),
      }
    },

    removed,
  }
}
