/**
 * Hosts, as this module reads them (spec 2026-10-07-dos-hosts, design D12). PURE, and in a `.ts`, so
 * `node --test` covers it.
 *
 * THE SERVING HOST IS `undefined` (`hostKey`, the one place that decides it). `GET /hosts` names it
 * like any other, but `/peers/<own name>/` would answer 404: in `apiOn`, `groupByHost` and a route
 * it is `undefined`, and in `navigate` it is `null` (`hostKey(name, hosts) ?? null`).
 */

import type { EngineSetupView } from '../types.ts'
import type { HostView } from './contract.ts'
import { ago } from './format.ts'

/** A name from `hosts` as the shell takes it: `undefined` for the serving host, else the name. */
export function hostKey(name: string | undefined, hosts: readonly HostView[]): string | undefined {
  if (name === undefined) return undefined
  return hosts.some((host) => host.self && host.name === name) ? undefined : name
}

/**
 * Whether `GET /hosts` says this host is down. Only a peer can be: the serving host is the one that
 * answered, and a name the list does not have (or no list yet) is not known to be down.
 */
export function isUnreachable(key: string | undefined, hosts: readonly HostView[]): boolean {
  if (key === undefined) return false
  return hosts.some((host) => !host.self && host.name === key && !host.reachable)
}

/**
 * The host a screen's bar names (criterion 13): another host's screen always says which; the serving
 * host's says its name only when there are peers to tell it from. `undefined`: the bar says nothing.
 */
export function barHost(here: string | undefined, hosts: readonly HostView[]): string | undefined {
  if (here !== undefined) return here
  return hosts.length > 1 ? hosts.find((host) => host.self)?.name : undefined
}

/** One host's group, for the drawer: its state from `hosts`, and whatever was loaded for it. */
export interface HostGroup<T> {
  /** What `apiOn` takes: `undefined` for the serving host. */
  readonly key: string | undefined
  /** `undefined` only while `GET /hosts` has not answered. */
  readonly name: string | undefined
  readonly reachable: boolean
  readonly lastSeenAt: string | null
  readonly data: T | undefined
}

/**
 * The serving host first, then each peer in the order `GET /hosts` gives. `byHost` is keyed by
 * `hostKey`, and a host with nothing in it — down, or not loaded yet — is still a group: what to show
 * for it is the drawer's call. Before `GET /hosts` answers there is one group, the serving host.
 */
export function groupByHost<T>(hosts: readonly HostView[], byHost: ReadonlyMap<string | undefined, T>): readonly HostGroup<T>[] {
  const self = hosts.find((host) => host.self)
  const own: HostGroup<T> = {
    key: undefined,
    name: self?.name,
    reachable: true,
    lastSeenAt: null,
    data: byHost.get(undefined),
  }
  const peers = hosts
    .filter((host) => !host.self)
    .map((host): HostGroup<T> => ({
      key: host.name,
      name: host.name,
      reachable: host.reachable,
      lastSeenAt: host.lastSeenAt,
      data: byHost.get(host.name),
    }))
  return [own, ...peers]
}

/**
 * What the launch screen picks when it mounts, from THIS host's setup only: the wanted project if
 * this host has it and can launch in it, else the first that can; the first entry not disabled.
 * Mounting again on another host (the screen is keyed by host) asks again with that host's setup.
 */
export function initialLaunchChoice(
  setup: EngineSetupView,
  wantedSiteId: string | undefined,
): { readonly siteId: string; readonly entryId: string } {
  // A project whose folder is missing launches nothing (criterion 23, as in `LaunchComposer`): it is not offered.
  const sites = setup.sites.filter((site) => site.status === 'ok')
  const wanted = sites.find((site) => site.id === wantedSiteId)
  return {
    siteId: (wanted ?? sites[0])?.id ?? '',
    entryId: setup.catalog.find((entry) => entry.disabledReason === undefined)?.id ?? '',
  }
}

/** What a host's heading in the drawer says under its name (criterion 10). */
export function hostStatus(host: { readonly reachable: boolean; readonly lastSeenAt: string | null }, now: number): string {
  if (host.reachable) return 'available'
  if (host.lastSeenAt === null) return 'unreachable · never seen'
  const when = ago(host.lastSeenAt, now)
  return `unreachable · last seen ${when === 'now' ? 'just now' : `${when} ago`}`
}

// --- The launch screen of a host (design D12, criterion 12) -----------------------------------------

const NEW = 'new'

/**
 * What the launcher's `rest` says: `new`, or `new/<siteId>` with the project «Run on» carried over
 * (the query would not survive: the shell takes it out). `undefined`: not the launcher.
 */
export function launchRest(rest: string): { readonly siteId: string | undefined } | undefined {
  if (rest === NEW) return { siteId: undefined }
  const m = /^new\/([^/]+)$/.exec(rest)
  if (m === null) return undefined
  try {
    return { siteId: decodeURIComponent(m[1] ?? '') }
  } catch {
    return { siteId: undefined }
  }
}

/** The launcher's `rest`, with the project to preselect if there is one. */
export function launchPath(siteId: string | undefined): string {
  return siteId === undefined || siteId === '' ? NEW : `${NEW}/${encodeURIComponent(siteId)}`
}

/** One host «Run on» offers. `key` is what `navigate` and `apiOn` take: `undefined` for the serving one. */
export interface RunOnChoice {
  readonly key: string | undefined
  readonly name: string
}

/**
 * The hosts «Run on» offers: the serving one and every REACHABLE peer — plus the screen's own even
 * while it is down, so the select has its value. Fewer than two is nothing to choose: no select, and
 * a daemon without peers looks as it did.
 */
export function runOnChoices(hosts: readonly HostView[], here: string | undefined): readonly RunOnChoice[] {
  const choices = hosts.flatMap((host): RunOnChoice[] => {
    if (host.self) return [{ key: undefined, name: host.name }]
    return host.reachable || host.name === here ? [{ key: host.name, name: host.name }] : []
  })
  return choices.length < 2 ? [] : choices
}

/**
 * Where «New» with no host goes (criterion 12): the peer last chosen on this device, while it is
 * reachable. Anything else — the serving host, one down, one no longer declared — stays where it is.
 */
export function rememberedLaunchHost(saved: string | undefined, hosts: readonly HostView[]): string | undefined {
  const key = hostKey(saved, hosts)
  if (key === undefined) return undefined
  return hosts.some((host) => !host.self && host.name === key && host.reachable) ? key : undefined
}

/**
 * How long after the launcher opens the remembered host may still redirect it (code review,
 * 2026-10-08). A first `GET /hosts` that works answers well inside it; one that FAILED is retried a
 * whole HOSTS_REFRESH_MS (5 s) later, when the owner may be typing — and a redirect then would remount
 * the composer under their fingers.
 */
export const LAUNCH_DECISION_MS = 2_000

/** Whether the launcher entered at `enteredAt` may still be sent to the remembered host. */
export function launchDecisionOpen(enteredAt: number, now: number): boolean {
  return now - enteredAt <= LAUNCH_DECISION_MS
}

/**
 * How often the drawer re-reads the clock while a peer is down: HOSTS_REFRESH_MS of the shell. While
 * a peer stays down `GET /hosts` answers the same list, the shell keeps the same array, and nothing
 * else would re-render "last seen … ago" (code review, 2026-10-08).
 */
export const LAST_SEEN_TICK_MS = 5_000

/** Whether "last seen … ago" is on screen: a peer down that was seen once. "never seen" does not age. */
export function lastSeenTicks(hosts: readonly HostView[]): boolean {
  return hosts.some((host) => !host.self && !host.reachable && host.lastSeenAt !== null)
}
