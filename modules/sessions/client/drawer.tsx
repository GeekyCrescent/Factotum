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
import { ago } from './format.ts'
import { history, type Waiting } from './history.ts'
import { Icon } from './icon.tsx'
import type { SessionIcon } from './icons.ts'
import { sessionOf, type Pending } from './relevance.ts'
import { toneClass } from './tone.ts'

const REFRESH_MS = 5_000
const TICK_MS = 1_000

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
  return (
    <div class="s-drawer" ref={root}>
      <button type="button" class="s-new" onClick={() => navigate('new')}>
        <Icon name="note-pencil" size={18} />
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
      {groups.map((group) => (
        <section key={group.key}>
          {/* A project's name in its own colour, with its dot: the one place the list says whose it is. */}
          <h2 class={group.key.startsWith('site:') ? `s-sect s-proj ${toneClass(group.label)}` : 's-sect'}>{group.label}</h2>
          {group.entries.map((entry) => {
            const asking = entry.detail !== undefined
            // Under its project the site would repeat; under Needs you and Running it says where.
            const where = group.key.startsWith('site:') ? '' : `${entry.site} · `
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
                  <small class={asking ? 'mono' : undefined}>{asking ? `${where}${entry.detail}` : `${where}${when}`}</small>
                </span>
              </button>
            )
          })}
        </section>
      ))}
    </div>
  )
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
