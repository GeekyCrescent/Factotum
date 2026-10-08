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
 * NO CONSOLE (criterion 41): the pendings it lists may hold tokens, and the search is typed here.
 */

import { useCallback, useState } from 'preact/hooks'
import type { DrawerProps } from './contract.ts'
import { HostDrawer } from './host-drawer.tsx'
import { groupByHost } from './hosts.ts'
import { Icon } from './icon.tsx'
import { onHost } from './relevance.ts'

/** Nothing is loaded per host up here: each part loads its own. */
const NO_DATA: ReadonlyMap<string | undefined, undefined> = new Map<string | undefined, undefined>()

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
      {groups.map((group) => (
        <HostDrawer
          key={group.key ?? ''}
          api={apiOn(group.key)}
          host={group.key}
          rest={rest}
          navigate={(next) => navigate(next, { host: group.key ?? null })}
          pending={onHost(pending, hosts, group.key)}
          query={query}
          selecting={selectingOn !== undefined && selectingOn.host === group.key}
          onSelecting={(on) => select(group.key, on)}
        />
      ))}
    </div>
  )
}
