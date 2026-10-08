/**
 * Which hosts there are, for every module at once (spec 2026-10-07-dos-hosts, design D12).
 *
 * A KERNEL ROUTE, NOT A MODULE'S: `GET /hosts`, like `/modules` and the push routes in `api.ts`, and
 * `ModuleApi` does not grow for it. The shell asks once for the whole app and hands the list to each
 * module as the `hosts` prop — what it already does with `pending`.
 *
 * On the drawer's rhythm (`modules/sessions/client/drawer.tsx`): at mount, on becoming visible, and
 * every HOSTS_REFRESH_MS while the page stays so. A failed read keeps the list it had: a daemon from
 * before `/hosts`, one starting, or no network all leave it as it was — empty at first, which a module
 * reads as "only the host serving the app".
 *
 * The parts that decide are pure and exported, so `node --test` covers them; `useHosts` only wires.
 */

import { useEffect, useState } from 'preact/hooks'
import { readResponse } from './api.ts'

/** One host as `GET /hosts` gives it. `lastSeenAt` is `null` for this host and a peer never seen. */
export interface HostView {
  readonly name: string
  readonly self: boolean
  readonly reachable: boolean
  readonly lastSeenAt: string | null
}

export const HOSTS_REFRESH_MS = 5_000
export const HOSTS_TICK_MS = 1_000

const NONE: readonly HostView[] = []

/**
 * The body of `GET /hosts`, read as data: a list, or `undefined` for anything else. A malformed entry
 * is dropped, and only the four keys survive. This host's entry carries no `lastSeenAt`: `null`.
 */
export function parseHosts(body: unknown): readonly HostView[] | undefined {
  if (!Array.isArray(body)) return undefined
  return body.flatMap((entry: unknown): HostView[] => {
    if (entry === null || typeof entry !== 'object') return []
    const { name, self, reachable, lastSeenAt } = entry as Record<string, unknown>
    if (typeof name !== 'string' || typeof self !== 'boolean' || typeof reachable !== 'boolean') return []
    return [{ name, self, reachable, lastSeenAt: typeof lastSeenAt === 'string' ? lastSeenAt : null }]
  })
}

/** `GET /hosts`. `undefined` when there is no list to be had; never throws. */
export async function fetchHosts(fetcher: typeof fetch = fetch): Promise<readonly HostView[] | undefined> {
  try {
    return parseHosts(await readResponse<unknown>(await fetcher('/hosts')))
  } catch {
    return undefined
  }
}

/** Same hosts in the same order and state: then the shell keeps the old array, and no effect re-runs. */
export function sameHosts(a: readonly HostView[], b: readonly HostView[]): boolean {
  return (
    a.length === b.length &&
    a.every((host, i) => {
      const other = b[i]
      return (
        other !== undefined &&
        host.name === other.name &&
        host.self === other.self &&
        host.reachable === other.reachable &&
        host.lastSeenAt === other.lastSeenAt
      )
    })
  )
}

/** Whether a tick asks again: at mount, on becoming visible, and every HOSTS_REFRESH_MS while visible. */
export function pollDue(tick: {
  readonly first: boolean
  readonly visible: boolean
  readonly wasVisible: boolean
  readonly now: number
  readonly fetchedAt: number
}): boolean {
  return tick.first || (tick.visible && (!tick.wasVisible || tick.now - tick.fetchedAt >= HOSTS_REFRESH_MS))
}

/** The hosts, polled. Call it ONCE, in the shell. */
export function useHosts(): readonly HostView[] {
  const [hosts, setHosts] = useState<readonly HostView[]>(NONE)

  useEffect(() => {
    let live = true
    let fetchedAt = 0
    let wasVisible = false
    const tick = (first = false) => {
      const visible = document.visibilityState === 'visible'
      const due = pollDue({ first, visible, wasVisible, now: Date.now(), fetchedAt })
      wasVisible = visible
      if (!due) return
      fetchedAt = Date.now()
      void fetchHosts().then((next) => {
        if (live && next !== undefined) setHosts((previous) => (sameHosts(previous, next) ? previous : next))
      })
    }
    tick(true)
    const timer = setInterval(() => tick(), HOSTS_TICK_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  return hosts
}
