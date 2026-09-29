/**
 * What this module puts in the shell's drawer: New session, a search, then Needs you, Running and
 * one group per project with its newest conversations, "Show more", and Manage projects (spec
 * 2026-09-29, D9).
 *
 * Its own `GET projects`, when it becomes visible and every REFRESH_MS while it stays so; a closed
 * drawer on a phone costs nothing. "Show more" pages through `GET sessions?site=`. The search
 * filters what is loaded at once and asks the daemon for the rest (`search-results.tsx`).
 *
 * SELECT turns the rows into checkboxes, for archiving or deleting several at once (D9).
 *
 * NO CONSOLE (criterion 41): the pendings it lists may hold tokens, and the search is typed here.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { ProjectsPage, SessionPage, SessionState, SessionSummary } from '../types.ts'
import type { DrawerProps } from './contract.ts'
import { messageOf } from './errors.ts'
import { ago, day } from './format.ts'
import { history, type Entry, type Group, type Waiting } from './history.ts'
import { Icon } from './icon.tsx'
import type { SessionIcon } from './icons.ts'
import { ConfirmSheet } from './project-forms.tsx'
import { grantOf, sessionOf, type Pending } from './relevance.ts'
import { SearchResults } from './search-results.tsx'
import { toneClass } from './tone.ts'

const REFRESH_MS = 5_000
const TICK_MS = 1_000
const FOLDED_KEY = 'factotum.sessions.folded'

const GLYPH: Readonly<Record<SessionState, SessionIcon>> = {
  running: 'circle-notch',
  finished: 'check-circle',
  failed: 'x-circle',
  cancelled: 'minus-circle',
}

interface RowState {
  readonly rest: string
  readonly now: number
  readonly selecting: boolean
  readonly picked: ReadonlySet<string>
  readonly onPick: (id: string) => void
  readonly navigate: (rest: string) => void
}

export function SessionsDrawer({ api, rest, navigate, pending }: DrawerProps) {
  const [page, setPage] = useState<ProjectsPage | undefined>(undefined)
  const [more, setMore] = useState<ReadonlyMap<string, { readonly sessions: readonly SessionSummary[]; readonly next: number }>>(new Map())
  const [query, setQuery] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [generation, setGeneration] = useState(0)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    let fetchedAt = 0
    let wasVisible = false
    const tick = (first = false) => {
      const element = root.current
      const visible = element !== null && element.checkVisibility?.({ visibilityProperty: true }) !== false
      // Once at mount whatever happens, so the list is there the moment the drawer slides in.
      const due = first || (visible && (!wasVisible || Date.now() - fetchedAt >= REFRESH_MS))
      wasVisible = visible
      if (!due) return
      fetchedAt = Date.now()
      api
        .get<ProjectsPage>('projects')
        .then((next) => {
          if (live) setPage(next)
        })
        .catch(() => undefined) // the list stays as it was; the screen itself reports failures
    }
    tick(true)
    const timer = setInterval(() => tick(), TICK_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [api, generation])

  const projects = page?.projects ?? []
  const groups = history(projects, new Map([...more].map(([id, m]) => [id, m.sessions])), waitingOf(pending), query)
  const { folded, toggle } = useFolded()
  const grants = pending.flatMap((p) => grantOf(p) ?? [])
  const searching = query.trim() !== ''
  const labelOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id
  const colorOf = (id: string) => projects.find((p) => p.id === id)?.color

  const showMore = async (siteId: string) => {
    const next = more.get(siteId)?.next ?? 0
    try {
      const got = await api.get<SessionPage>(`sessions?site=${encodeURIComponent(siteId)}&page=${next}`)
      setMore((current) => {
        const copy = new Map(current)
        copy.set(siteId, { sessions: [...(current.get(siteId)?.sessions ?? []), ...got.sessions], next: next + 1 })
        return copy
      })
    } catch (cause: unknown) {
      setFailure(messageOf(cause))
    }
  }

  const onPick = (id: string) =>
    setPicked((current) => {
      const copy = new Set(current)
      if (copy.has(id)) copy.delete(id)
      else copy.add(id)
      return copy
    })

  const stopSelecting = () => {
    setSelecting(false)
    setPicked(new Set())
    setConfirming(false)
    setFailure(undefined)
  }

  /** Runs on the picked ids; `work` returns the ids it could not change. */
  const onMany = async (work: (ids: readonly string[]) => Promise<readonly string[]>) => {
    setBusy(true)
    setFailure(undefined)
    try {
      const refused = await work([...picked])
      if (refused.length > 0) setFailure(`${refused.length} could not be changed: a running conversation is left as it is.`)
      else stopSelecting()
      setMore(new Map())
      setGeneration((n) => n + 1)
    } catch (cause: unknown) {
      setFailure(messageOf(cause))
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  const archiveMany = async (ids: readonly string[]) => {
    const tried = await Promise.all(ids.map((id) => api.post(`sessions/${id}/archive`, { archived: true }).then(() => undefined, () => id)))
    return tried.filter((id): id is string => id !== undefined)
  }

  const deleteMany = async (ids: readonly string[]) => {
    const done = await api.post<{ results: readonly { id: string; outcome: string }[] }>('sessions/remove', { ids })
    return done.results.filter((r) => r.outcome !== 'removed').map((r) => r.id)
  }

  const rows: RowState = { rest, now: Date.now(), selecting, picked, onPick, navigate }

  return (
    <div class="s-drawer" ref={root}>
      <button type="button" class="s-new" onClick={() => navigate('new')}>
        <Icon name="plus" size={16} />
        New session
      </button>
      <label class="s-search">
        <Icon name="magnifying-glass" size={16} />
        <input
          type="search"
          value={query}
          placeholder="Search conversations…"
          aria-label="Search conversations"
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
        />
      </label>
      <div class="s-drawer-tools">
        {selecting ? (
          <>
            <span class="dim-3 num">{picked.size} selected</span>
            <button type="button" class="btn quiet sm" disabled={busy || picked.size === 0} onClick={() => void onMany(archiveMany)}>
              Archive
            </button>
            <button type="button" class="btn quiet sm s-danger" disabled={busy || picked.size === 0} onClick={() => setConfirming(true)}>
              Delete
            </button>
            <button type="button" class="btn quiet sm" onClick={stopSelecting}>
              Done
            </button>
          </>
        ) : (
          <>
            <button type="button" class="btn quiet sm" onClick={() => navigate('projects')}>
              <Icon name="folder-simple" size={14} />
              Manage projects
            </button>
            <button type="button" class="btn quiet sm" onClick={() => setSelecting(true)}>
              <Icon name="check-square" size={14} />
              Select
            </button>
          </>
        )}
      </div>
      {failure === undefined ? null : (
        <p class="s-error" role="alert">
          {failure}
        </p>
      )}
      {grants.length === 0 || searching ? null : (
        <section>
          <h2 class="s-sect">Folders waiting</h2>
          {grants.map((grant) => (
            <button type="button" key={grant.tag} class="s-item s-asking" onClick={() => navigate('projects')}>
              <span class="s-g s-g-ask">
                <Icon name="hand" size={18} />
              </span>
              <span class="s-item-text">
                <b>{grant.name ?? 'A new folder'}</b>
                <small>Waiting for approval</small>
              </span>
            </button>
          ))}
        </section>
      )}
      {groups.map((group) =>
        group.project === undefined ? (
          <section key={group.key}>
            <h2 class="s-sect">{group.label}</h2>
            {group.entries.map((entry) => (
              <Row key={entry.id} entry={entry} compact={false} rows={rows} />
            ))}
          </section>
        ) : (
          <Project
            key={group.key}
            group={group}
            // A search shows every match: a folded project would hide the very thing looked for.
            folded={!searching && folded.has(group.project.id)}
            onToggle={toggle}
            rows={rows}
            onMore={(id) => void showMore(id)}
          />
        ),
      )}
      {page !== undefined && projects.length === 0 && !searching ? (
        <p class="s-none">
          No projects yet.{' '}
          <button type="button" class="s-link" onClick={() => navigate('projects')}>
            Add one
          </button>
        </p>
      ) : null}
      {searching ? (
        <SearchResults
          api={api}
          query={query}
          shown={new Set(groups.flatMap((g) => g.entries.map((e) => e.id)))}
          labelOf={labelOf}
          colorOf={colorOf}
          rest={rest}
          navigate={navigate}
        />
      ) : null}
      {confirming ? (
        <ConfirmSheet
          title={`Delete ${picked.size} conversation${picked.size === 1 ? '' : 's'}?`}
          body="Their logs are deleted for good. The files the agents changed stay as they are."
          action="Delete"
          busy={busy}
          error={undefined}
          onClose={() => setConfirming(false)}
          onConfirm={() => void onMany(deleteMany)}
        />
      ) : null}
    </div>
  )
}

/**
 * One conversation. COMPACT under its project — its title, its date, and a mark only when it failed —
 * unless it waits on the owner, runs, or the drawer is selecting: then the full row, with its glyph
 * or its checkbox.
 */
function Row({ entry, compact, rows }: { readonly entry: Entry; readonly compact: boolean; readonly rows: RowState }) {
  const asking = entry.detail !== undefined
  const picked = rows.picked.has(entry.id)
  const onClick = () => (rows.selecting ? rows.onPick(entry.id) : rows.navigate(entry.id))
  if (compact && !asking && entry.state !== 'running' && !rows.selecting) {
    return (
      <button type="button" class="s-conv" aria-current={rows.rest === entry.id ? 'page' : undefined} onClick={onClick}>
        <span class="s-conv-title">{entry.title}</span>
        {entry.state === 'failed' ? <Icon name="x-circle" size={14} /> : null}
        {entry.startedAt === undefined ? null : <span class="s-conv-date num">{day(entry.startedAt, rows.now)}</span>}
      </button>
    )
  }
  const when = entry.startedAt === undefined ? '' : ago(entry.startedAt, rows.now)
  return (
    <button
      type="button"
      class={`s-item ${toneClass(entry.site, entry.color)}${asking ? ' s-asking' : ''}`}
      aria-current={rows.rest === entry.id && !rows.selecting ? 'page' : undefined}
      aria-pressed={rows.selecting ? picked : undefined}
      onClick={onClick}
    >
      <span class={`s-g ${rows.selecting ? (picked ? 's-g-picked' : 's-g-pick') : `s-g-${asking ? 'ask' : entry.state}`}`}>
        <Icon name={rows.selecting ? (picked ? 'check-square' : 'square') : asking ? 'hand' : GLYPH[entry.state]} size={18} />
      </span>
      <span class="s-item-text">
        <b>{entry.title}</b>
        <small class={asking ? 'mono' : undefined}>{`${entry.siteLabel} · ${asking ? entry.detail : when}`}</small>
      </span>
    </button>
  )
}

/**
 * One project, the way a chat app lists them: its folder in its colour and its name, a tap to fold
 * it, its conversations, and "Show more" while there are more. Folded, it keeps only the one open on
 * screen. Missing, it says so and lists nothing: its conversations are not read (criterion 25).
 */
function Project({
  group,
  folded,
  onToggle,
  rows,
  onMore,
}: {
  readonly group: Group
  readonly folded: boolean
  readonly onToggle: (id: string) => void
  readonly rows: RowState
  readonly onMore: (id: string) => void
}) {
  const id = group.project?.id ?? group.label
  const missing = group.project?.status === 'missing'
  return (
    <section class={`s-project ${toneClass(id, group.project?.color)}`}>
      <button type="button" class="s-project-head" aria-expanded={!folded} onClick={() => onToggle(id)}>
        <Icon name={missing ? 'warning' : 'folder-simple'} size={18} />
        <span class="s-project-name">{group.label}</span>
        <Icon name={folded ? 'caret-right' : 'caret-down'} size={12} />
      </button>
      {missing && !folded ? <p class="s-missing s-indent">Folder missing</p> : null}
      {/* Folded, it still shows the conversation that is open: where you are never disappears. */}
      {(folded ? group.entries.filter((entry) => entry.id === rows.rest) : group.entries).map((entry) => (
        <Row key={entry.id} entry={entry} compact rows={rows} />
      ))}
      {!folded && group.project?.hasMore === true ? (
        <button type="button" class="s-more" onClick={() => onMore(id)}>
          Show more
        </button>
      ) : null}
    </section>
  )
}

/** Which projects the owner folded, by id, remembered on this device. Storage off: they start open. */
function useFolded(): { readonly folded: ReadonlySet<string>; readonly toggle: (site: string) => void } {
  const [folded, setFolded] = useState<ReadonlySet<string>>(readFolded)
  const toggle = (site: string) => {
    const next = new Set(folded)
    if (next.has(site)) next.delete(site)
    else next.add(site)
    setFolded(next)
    writeFolded(next)
  }
  return { folded, toggle }
}

function readFolded(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(FOLDED_KEY) ?? '[]')
    return new Set(Array.isArray(stored) ? stored.filter((site): site is string => typeof site === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeFolded(folded: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]))
  } catch {
    // Not remembered; it still folds for this visit.
  }
}

/** The first pending per session, with the site and what it asks for as the notice carried them. */
function waitingOf(pending: readonly Pending[]): Waiting {
  const waiting = new Map<string, { site: string | undefined; detail: string }>()
  for (const p of pending) {
    const id = sessionOf(p)
    if (id === undefined || waiting.has(id)) continue
    const text = (key: string) => (typeof p.data[key] === 'string' ? (p.data[key] as string) : undefined)
    waiting.set(id, { site: text('siteId'), detail: [text('toolName'), text('file')].filter(Boolean).join(' ') || 'Waiting for you' })
  }
  return waiting
}
