/**
 * Search the history: titles, projects, and THE TEXT OF THE MESSAGES (spec 2026-09-29, D7).
 *
 * A WALK, NOT AN INDEX. Block A measured it: 500 sessions of prod's largest size, walked with no
 * match at all, took 26 ms (85 ms at twenty times that size). So each search reads the logs it
 * needs, newest first, and stops at the first match per conversation and at 50 conversations.
 *
 * ONLY MESSAGES, never tool inputs or results: those hold file contents the owner did not write and
 * did not ask to search. The messages the engine writes itself ("launched over a freshness
 * warning") are part of the log and are found too; that is accepted (D7).
 *
 * Archived conversations are searched; those of a MISSING or REMOVED project are not (criterion 25).
 */

import type { SessionIndex } from './index-cache.ts'
import { summaryOf } from './history.ts'
import type { SiteTable } from './projects.ts'
import type { SessionMeta, SessionStore } from './store.ts'
import type { SearchHit } from './types.ts'
import { stripRefs } from './uploads/refs.ts'

/** At most this many conversations (criterion 38). */
export const SEARCH_LIMIT = 50

/** Characters of context on each side of a match (criterion 38). */
export const SNIPPET_SIDE = 60

export interface SearchDeps {
  readonly index: SessionIndex
  readonly store: SessionStore
  readonly table: SiteTable
  readonly ensureIndex: () => Promise<void>
  /**
   * Where uploads live. With it, a message's reference lines are dropped before searching and cutting
   * the snippet, so a search never finds or shows an upload's path (spec 2026-10-01, criterion 32).
   * Optional so the setups that predate uploads still compile.
   */
  readonly uploadsRoot?: string
}

/** The phrase around a match, on one line, with an ellipsis where it was cut. */
export function snippetOf(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_SIDE)
  const end = Math.min(text.length, at + length + SNIPPET_SIDE)
  const middle = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${middle}${end < text.length ? '…' : ''}`
}

export async function searchHistory(deps: SearchDeps, query: string): Promise<readonly SearchHit[]> {
  const wanted = query.trim().toLowerCase()
  if (wanted.length < 2) return []
  await deps.ensureIndex()
  await deps.table.refreshAll()

  const hits: SearchHit[] = []
  for (const meta of deps.index.all()) {
    if (hits.length >= SEARCH_LIMIT) break
    if (deps.table.status(meta.siteId) !== 'ok') continue
    if (namedBy(meta, deps.table, wanted)) {
      hits.push({ summary: summaryOf(meta), snippet: undefined })
      continue
    }
    const page = await deps.store.read(meta.id, 0)
    for (const event of page.events) {
      if (event.kind !== 'message') continue
      const text = deps.uploadsRoot === undefined ? event.text : stripRefs(event.text, deps.uploadsRoot)
      const at = text.toLowerCase().indexOf(wanted)
      if (at === -1) continue
      hits.push({ summary: summaryOf(meta), snippet: snippetOf(text, at, wanted.length) })
      break
    }
  }
  return hits
}

/** Its title, the titler's, its first prompt, its project's id or name. */
function namedBy(meta: SessionMeta, table: SiteTable, wanted: string): boolean {
  const name = table.entry(meta.siteId)?.name
  return [meta.title, meta.autoTitle, meta.prompt, meta.siteId, name].some((field) => field?.toLowerCase().includes(wanted) === true)
}
