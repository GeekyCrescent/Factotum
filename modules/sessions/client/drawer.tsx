/**
 * What this module puts in the shell's drawer: New session, then Needs you, Running, Today and
 * Earlier (spec 2026-09-18, design D5).
 *
 * Its own `GET sessions?page=0`, when it becomes visible and every REFRESH_MS while it stays so; a
 * closed drawer on a phone costs nothing. Only page 0 (25 sessions): the drawer does not paginate.
 *
 * NO CONSOLE (criterion 37): the pendings it lists may hold ask tokens.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { SessionPage, SessionState, SessionSummary } from '../types.ts'
import type { DrawerProps } from './contract.ts'
import { clip, isToday } from './format.ts'
import { Icon } from './icon.tsx'
import type { SessionIcon } from './icons.ts'
import { sessionOf, type Pending } from './relevance.ts'

const REFRESH_MS = 5_000
const TICK_MS = 1_000
const PROMPT_SHOWN = 80

const GLYPH: Readonly<Record<SessionState, SessionIcon>> = {
  running: 'circle-notch',
  finished: 'check-circle',
  failed: 'x-circle',
  cancelled: 'minus-circle',
}

interface Item {
  readonly id: string
  readonly site: string
  readonly line: string
  readonly glyph: SessionIcon
  readonly tone: string
}

export function SessionsDrawer({ api, rest, navigate, pending }: DrawerProps) {
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
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

  const groups = group(sessions, pending, Date.now())
  return (
    <div class="s-drawer" ref={root}>
      <button type="button" class="s-new" onClick={() => navigate('new')}>
        <Icon name="note-pencil" size={18} />
        New session
      </button>
      {groups.map(([title, items]) =>
        items.length === 0 ? null : (
          <section key={title}>
            <h2 class="s-sect">{title}</h2>
            {items.map((item) => (
              <button
                type="button"
                key={item.id}
                class={`s-item${item.tone === 'ask' ? ' s-asking' : ''}`}
                aria-current={rest === item.id ? 'page' : undefined}
                onClick={() => navigate(item.id)}
              >
                <span class={`s-g s-g-${item.tone}`}>
                  <Icon name={item.glyph} size={18} />
                </span>
                <span class="s-item-text">
                  <b>{item.site}</b>
                  <small class={item.tone === 'ask' ? 'mono' : undefined}>{item.line}</small>
                </span>
              </button>
            ))}
          </section>
        ),
      )}
    </div>
  )
}

function group(sessions: readonly SessionSummary[], pending: readonly Pending[], now: number): readonly [string, readonly Item[]][] {
  const waiting = new Map<string, Pending>()
  for (const p of pending) {
    const id = sessionOf(p)
    if (id !== undefined && !waiting.has(id)) waiting.set(id, p)
  }
  const known = new Map(sessions.map((s) => [s.id, s]))
  const needs: Item[] = [...waiting].map(([id, p]) => {
    const text = (key: string) => (typeof p.data[key] === 'string' ? (p.data[key] as string) : undefined)
    return {
      id,
      site: known.get(id)?.siteId ?? text('siteId') ?? id.slice(0, 8),
      line: [text('toolName'), text('file')].filter(Boolean).join(' ') || 'Waiting for you',
      glyph: 'hand',
      tone: 'ask',
    }
  })
  const rest = sessions.filter((s) => !waiting.has(s.id)).map((s) => itemOf(s))
  const running = rest.filter((item) => item.tone === 'running')
  const ended = sessions.filter((s) => !waiting.has(s.id) && s.state !== 'running')
  const today = ended.filter((s) => isToday(s.startedAt, now)).map(itemOf)
  const earlier = ended.filter((s) => !isToday(s.startedAt, now)).map(itemOf)
  return [
    ['Needs you', needs],
    ['Running', running],
    ['Today', today],
    ['Earlier', earlier],
  ]
}

function itemOf(session: SessionSummary): Item {
  return {
    id: session.id,
    site: session.siteId,
    line: clip(session.prompt ?? session.entryId, PROMPT_SHOWN),
    glyph: GLYPH[session.state],
    tone: session.state,
  }
}
