/**
 * What the daemon found for a search the drawer could not answer from what it has loaded: every
 * conversation of every project that is there, archived ones included, by title, by project and by
 * the text of its messages, with the phrase around the match (spec 2026-09-29, D7, D9).
 *
 * ASKED 300 ms AFTER THE LAST KEY, not on every one, and only from two characters (criterion 38).
 * Conversations the drawer already shows are not repeated.
 *
 * NO CONSOLE (criterion 41): the query and the snippets pass through here.
 */

import { useEffect, useState } from 'preact/hooks'
import type { SearchHit } from '../types.ts'
import type { Api } from './contract.ts'
import { day } from './format.ts'
import { nameOf } from './history.ts'
import { toneClass } from './tone.ts'

const DEBOUNCE_MS = 300
const MIN_CHARS = 2

export function SearchResults({
  api,
  query,
  shown,
  labelOf,
  colorOf,
  rest,
  navigate,
}: {
  readonly api: Api
  readonly query: string
  /** Ids the drawer already lists for this query. */
  readonly shown: ReadonlySet<string>
  readonly labelOf: (siteId: string) => string
  readonly colorOf: (siteId: string) => number | undefined
  readonly rest: string
  readonly navigate: (rest: string) => void
}) {
  const [hits, setHits] = useState<readonly SearchHit[] | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const wanted = query.trim()

  useEffect(() => {
    setHits(undefined)
    setFailed(false)
    if (wanted.length < MIN_CHARS) return undefined
    let live = true
    const timer = setTimeout(() => {
      api
        .get<{ hits: readonly SearchHit[] }>(`search?q=${encodeURIComponent(wanted)}`)
        .then((result) => {
          if (live) setHits(result.hits)
        })
        .catch(() => {
          if (live) setFailed(true)
        })
    }, DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [api, wanted])

  if (wanted.length < MIN_CHARS) return null
  if (failed) return <p class="s-none">The search could not be run.</p>
  if (hits === undefined) return <p class="s-none">Searching the messages…</p>
  const fresh = hits.filter((hit) => !shown.has(hit.summary.id))
  if (fresh.length === 0) return shown.size === 0 ? <p class="s-none">Nothing matches “{wanted}”.</p> : null
  const now = Date.now()
  return (
    <section class="s-results">
      <h2 class="s-sect">In all conversations</h2>
      {fresh.map((hit) => (
        <button
          type="button"
          key={hit.summary.id}
          class={`s-hit ${toneClass(hit.summary.siteId, colorOf(hit.summary.siteId))}`}
          aria-current={rest === hit.summary.id ? 'page' : undefined}
          onClick={() => navigate(hit.summary.id)}
        >
          <span class="s-hit-head">
            <b>{nameOf(hit.summary)}</b>
            <span class="s-conv-date num">{day(hit.summary.startedAt, now)}</span>
          </span>
          <small>
            {labelOf(hit.summary.siteId)}
            {hit.summary.archived ? ' · archived' : ''}
          </small>
          {hit.snippet === undefined ? null : <span class="s-snippet">{hit.snippet}</span>}
        </button>
      ))}
    </section>
  )
}
