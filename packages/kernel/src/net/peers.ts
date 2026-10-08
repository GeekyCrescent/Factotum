/**
 * The other daemon (spec 2026-10-07, D1 and D2): who it is, whether it answers, and the ONLY place
 * a URL towards it is built.
 *
 * A peer is declared in the config by its `publicOrigin`, never discovered. Its name is
 * `machineName(origin)`, and that name is what the client puts in `/h/<name>/…` and the proxy reads
 * back out of `/peers/<name>/…` — so it is checked at boot to be something a path can carry.
 */

import type { Logger, PeerConfig } from '@factotum/core'

/** What `/peers/<name>/` accepts, read raw. A name outside it is a peer nobody can address. */
export const PEER_NAME = /^[a-z0-9-]+$/

/**
 * The first label of the public hostname: `juans-macbook-pro`, not the whole
 * `juans-macbook-pro.tailbd0167.ts.net`. It is what tells two machines' notices apart on a
 * phone, and a notification title has no room for a tailnet suffix.
 *
 * ONE PLACE (design D1): push titles, `/hosts`, the proxy prefix and `doctor` all key on it.
 */
export function machineName(publicOrigin: string): string {
  return new URL(publicOrigin).hostname.split('.')[0] ?? publicOrigin
}

export interface PeerState {
  readonly name: string
  readonly origin: string
  readonly reachable: boolean
  /** ISO time of the last probe that found it ready. `undefined` until one has. */
  readonly lastSeenAt: string | undefined
  readonly version: string | undefined
  /** Its push subscriptions, from its `/health`. */
  readonly devices: number
}

export interface PeerTable {
  readonly list: () => readonly PeerState[]
  readonly get: (name: string) => PeerState | undefined
}

export interface PeerTableDeps {
  readonly peers: readonly PeerConfig[]
  readonly log: Logger
}

export function createPeerTable(deps: PeerTableDeps): PeerTable {
  const states = new Map<string, PeerState>(
    deps.peers.map(({ origin }) => {
      const name = machineName(origin)
      return [name, { name, origin, reachable: false, lastSeenAt: undefined, version: undefined, devices: 0 }]
    }),
  )

  return {
    list: () => [...states.values()],
    get: (name) => states.get(name),
  }
}
