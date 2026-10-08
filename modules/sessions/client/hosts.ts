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

/** A name from `hosts` as the shell takes it: `undefined` for the serving host, else the name. */
export function hostKey(name: string | undefined, hosts: readonly HostView[]): string | undefined {
  if (name === undefined) return undefined
  return hosts.some((host) => host.self && host.name === name) ? undefined : name
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
