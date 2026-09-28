/**
 * What this module puts in the shell's drawer: New session, a search, then Needs you, Running and
 * one group per project, each session named by its first prompt (`history.ts`).
 *
 * Its own `GET sessions?page=0`, when it becomes visible and every REFRESH_MS while it stays so; a
 * closed drawer on a phone costs nothing. Only page 0 (25 sessions): the drawer does not paginate,
 * so the search looks through those.
 *
 * NO CONSOLE (criterion 37): the pendings it lists may hold ask tokens.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { SessionPage, SessionState, SessionSummary } from '../types.ts'
import type { DrawerProps } from './contract.ts'
import { ago, day } from './format.ts'
import { history, type Group, type Waiting } from './history.ts'
import { Icon } from './icon.tsx'
import type { SessionIcon } from './icons.ts'
import { sessionOf, type Pending } from './relevance.ts'
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

export function SessionsDrawer({ api, rest, navigate, pending }: DrawerProps) {
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
  const [query, setQuery] = useState('')
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
        .get<SessionPage>('sessions?page=0')
        .then((page) => {
          if (live) setSessions(page.sessions)
        })
        .catch(() => undefined) // the list stays as it was; the screen itself reports failures
    }
    tick(true)
    const timer = setInterval(() => tick(), TICK_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [api])

  const now = Date.now()
  const groups = history(sessions, waitingOf(pending), query)
  const { folded, toggle } = useFolded()
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
      {groups.length === 0 && query.trim() !== '' ? <p class="s-none">Nothing matches “{query.trim()}”.</p> : null}
      {groups.map((group) =>
        group.key.startsWith('site:') ? (
          <Project
            key={group.key}
            group={group}
            // A search shows every match: a folded project would hide the very thing looked for.
            folded={query.trim() === '' && folded.has(group.label)}
            onToggle={() => toggle(group.label)}
            rest={rest}
            navigate={navigate}
            now={now}
          />
        ) : (
          <section key={group.key}>
            <h2 class="s-sect">{group.label}</h2>
            {group.entries.map((entry) => {
              const asking = entry.detail !== undefined
              const when = entry.startedAt === undefined ? '' : ago(entry.startedAt, now)
              return (
                <button
                  type="button"
                  key={entry.id}
                  class={`s-item ${toneClass(entry.site)}${asking ? ' s-asking' : ''}`}
                  aria-current={rest === entry.id ? 'page' : undefined}
                  onClick={() => navigate(entry.id)}
                >
                  <span class={`s-g s-g-${asking ? 'ask' : entry.state}`}>
                    <Icon name={asking ? 'hand' : GLYPH[entry.state]} size={18} />
                  </span>
                  <span class="s-item-text">
                    <b>{entry.title}</b>
                    <small class={asking ? 'mono' : undefined}>{`${entry.site} · ${asking ? entry.detail : when}`}</small>
                  </span>
                </button>
              )
            })}
          </section>
        ),
      )}
    </div>
  )
}

/**
 * One project, the way a chat app lists them: its folder in its colour and its name, a tap to fold
 * it, and under it one line per conversation: its title and its date, and a mark only when it failed.
 * Folded, it keeps only the conversation open on screen.
 */
function Project({
  group,
  folded,
  onToggle,
  rest,
  navigate,
  now,
}: {
  readonly group: Group
  readonly folded: boolean
  readonly onToggle: () => void
  readonly rest: string
  readonly navigate: (rest: string) => void
  readonly now: number
}) {
  return (
    <section class={`s-project ${toneClass(group.label)}`}>
      <button type="button" class="s-project-head" aria-expanded={!folded} onClick={onToggle}>
        <Icon name="folder-simple" size={18} />
        <span class="s-project-name">{group.label}</span>
        <Icon name={folded ? 'caret-right' : 'caret-down'} size={12} />
      </button>
      {/* Folded, it still shows the conversation that is open: where you are never disappears. */}
      {(folded ? group.entries.filter((entry) => entry.id === rest) : group.entries).map((entry) => (
            <button
              type="button"
              key={entry.id}
              class="s-conv"
              aria-current={rest === entry.id ? 'page' : undefined}
              onClick={() => navigate(entry.id)}
            >
              <span class="s-conv-title">{entry.title}</span>
              {entry.state === 'failed' ? <Icon name="x-circle" size={14} /> : null}
              {entry.startedAt === undefined ? null : <span class="s-conv-date num">{day(entry.startedAt, now)}</span>}
            </button>
          ))}
    </section>
  )
}

/** Which projects the owner folded, remembered on this device. Storage off: they start open. */
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
