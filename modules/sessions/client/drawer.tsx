/**
 * What this module puts in the shell's drawer: New session, a search, then each host's part —
 * Needs you, Running and one group per project with its newest conversations and "Show more" (spec
 * 2026-09-29, D9). The projects themselves are managed from Settings (spec 2026-09-30).
 *
 * ONE PART PER HOST (spec 2026-10-07-dos-hosts, design D12; criterion 11): `host-drawer.tsx`, once for
 * the serving host and once per peer in `hosts`, each with `apiOn(host)`. Each part asks its own
 * host on its own timer, so the two lists load in parallel and a host that does not answer delays
 * nothing of the other's. With no peers there is one part and the drawer is what it was.
 *
 * WITH PEERS, each part sits under its host's heading: a dot, the name, and "available" or
 * "unreachable · last seen …" (criterion 10). A host that is down is FOLDED AND GREY, and its part is
 * not mounted, so nothing asks it anything until it is back. One that is up folds on a tap,
 * remembered per device like a project.
 *
 * «MOVE MY SESSIONS TO …» (tasks K3): the heading's menu, on a host that is up while the other one is
 * too. It opens the handoff sheet against THAT host's api: the sessions that go are its own.
 *
 * NO CONSOLE (criterion 41): the pendings it lists may hold tokens, and the search is typed here.
 */

import { useCallback, useEffect, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import type { DrawerProps } from './contract.ts'
import { HostDrawer, useFolded } from './host-drawer.tsx'
import { ContextMenu, MenuItem, type MenuAt } from './context-menu.tsx'
import { HandoffSheet } from './handoff-sheet.tsx'
import { groupByHost, hostStatus, LAST_SEEN_TICK_MS, lastSeenTicks, moveTargetOf, type HostGroup } from './hosts.ts'
import { Icon } from './icon.tsx'
import { onHost } from './relevance.ts'

/** Nothing is loaded per host up here: each part loads its own. */
const NO_DATA: ReadonlyMap<string | undefined, undefined> = new Map<string | undefined, undefined>()
/** The hosts the owner folded on this device, by name. */
const HOSTS_FOLDED_KEY = 'factotum.sessions.hosts.folded'

export function SessionsDrawer({ apiOn, hosts, rest, navigate, pending }: DrawerProps) {
  const [query, setQuery] = useState('')
  // Which host is selecting, if any: a selection never mixes hosts (requirements §8, v3.3).
  const [selectingOn, setSelectingOn] = useState<{ readonly host: string | undefined } | undefined>(undefined)
  const select = useCallback(
    (host: string | undefined, on: boolean) =>
      setSelectingOn((current) => (on ? { host } : current?.host === host ? undefined : current)),
    [],
  )
  const groups = groupByHost(hosts, NO_DATA)
  const hostsFolded = useFolded(HOSTS_FOLDED_KEY)
  const now = useLastSeenClock(lastSeenTicks(hosts))
  const [moving, setMoving] = useState<{ readonly key: string | undefined; readonly from: string; readonly to: string } | undefined>(undefined)
  // The parts read their lists on their own timers; remounting them after a handoff reads them now.
  const [generation, setGeneration] = useState(0)

  return (
    <div class="s-drawer">
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
      {groups.map((group) => {
        const part = (
          <HostDrawer
            key={`${group.key ?? ''}#${generation}`}
            api={apiOn(group.key)}
            host={group.key}
            rest={rest}
            navigate={(next) => navigate(next, { host: group.key ?? null })}
            pending={onHost(pending, hosts, group.key)}
            query={query}
            selecting={selectingOn !== undefined && selectingOn.host === group.key}
            onSelecting={(on) => select(group.key, on)}
          />
        )
        const name = group.name ?? ''
        // ALWAYS a HostBlock, headed or not: the same tree when the first GET /hosts adds a peer, so
        // the serving host's part is not mounted again and loses nothing.
        return (
          <HostBlock
            key={group.key ?? ''}
            group={group}
            heading={groups.length > 1}
            now={now}
            folded={hostsFolded.folded.has(name)}
            onToggle={() => hostsFolded.toggle(name)}
            moveTo={moveTargetOf(group, hosts)}
            onMove={(to) => setMoving({ key: group.key, from: name, to })}
          >
            {part}
          </HostBlock>
        )
      })}
      {moving === undefined ? null : (
        <HandoffSheet
          api={apiOn(moving.key)}
          from={moving.from}
          to={moving.to}
          onClose={() => setMoving(undefined)}
          onMoved={() => setGeneration((n) => n + 1)}
        />
      )}
    </div>
  )
}

/**
 * The time "last seen … ago" is measured against. It ticks every LAST_SEEN_TICK_MS ONLY while a peer
 * that was seen is down: otherwise nothing on screen ages, and the drawer does not re-render for it.
 */
function useLastSeenClock(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), LAST_SEEN_TICK_MS)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

/**
 * One host's heading and, unless it is folded or down, its part of the drawer. Down, the heading
 * cannot be opened: there is nothing to show that would not be stale.
 */
function HostBlock({
  group,
  heading,
  now,
  folded,
  onToggle,
  moveTo,
  onMove,
  children,
}: {
  readonly group: HostGroup<unknown>
  /** One host, or GET /hosts not answered yet: no heading, and the drawer is as it was. */
  readonly heading: boolean
  readonly now: number
  readonly folded: boolean
  readonly onToggle: () => void
  /** Where this host's sessions can move, if anywhere (`moveTargetOf`). */
  readonly moveTo: string | undefined
  readonly onMove: (to: string) => void
  readonly children: ComponentChildren
}) {
  const [menu, setMenu] = useState<MenuAt | undefined>(undefined)
  // The same element with and without a heading, so its part stays mounted when one appears.
  if (!heading) return <section>{children}</section>
  const shut = folded || !group.reachable
  return (
    <section class={group.reachable ? 's-host' : 's-host s-host-down'} aria-label={group.name}>
      <div class="s-host-bar">
        <button type="button" class="s-host-head" aria-expanded={!shut} disabled={!group.reachable} onClick={onToggle}>
          <span class="s-host-dot" aria-hidden="true" />
          <span class="s-host-name">{group.name}</span>
          <small class="s-host-state">{hostStatus(group, now)}</small>
          {group.reachable ? <Icon name={shut ? 'caret-right' : 'caret-down'} size={12} /> : null}
        </button>
        {moveTo === undefined ? null : (
          <button
            type="button"
            class="icon-btn s-host-more"
            aria-label={`More for ${group.name ?? 'this host'}`}
            onClick={(event) => setMenu({ x: event.clientX, y: event.clientY })}
          >
            <Icon name="dots-three" size={16} />
          </button>
        )}
      </div>
      {menu === undefined || moveTo === undefined ? null : (
        <ContextMenu at={menu} onClose={() => setMenu(undefined)}>
          <MenuItem
            icon="arrow-up"
            label={`Move my sessions to ${moveTo}`}
            disabled={false}
            onChoose={() => {
              setMenu(undefined)
              onMove(moveTo)
            }}
          />
        </ContextMenu>
      )}
      {shut ? null : children}
    </section>
  )
}
