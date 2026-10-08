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
  /**
   * Where `rawRest` lands on the peer called `name`, or `undefined` if it may not go there.
   * `rawRest` is what follows `/peers/<name>` in `req.url` AS RECEIVED (design D3).
   */
  readonly url: (name: string, rawRest: string) => URL | undefined
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
    url: (name, rawRest) => {
      const peer = states.get(name)
      return peer === undefined ? undefined : peerUrl(peer.origin, rawRest)
    },
  }
}

/** A module route with its own segments, or the peer's `/health`. Nothing else leaves. */
const ALLOWED_PATH = /^\/(modules\/[a-z0-9][a-z0-9-]*(\/[A-Za-z0-9._~!$&'()*+,;=:@%-]*)*|health)$/

/** Dot segments, an empty segment, and the escapes that would become one of them further on. */
const TRAVERSAL = /(^|\/)\.\.?(\/|$)|\/\/|%2e|%2f|%5c|\\/i

/**
 * THE OUTGOING URL IS BUILT HERE AND NOWHERE ELSE (criterion 7), from a RAW path.
 *
 * Raw, not the `path` that `handle()` normalises and decodes: decoded, a `%3F` would become a query
 * and a `%2e` a dot. The query is not looked at — it cannot change the host — so a search for
 * `src/app` (`q=src%2Fapp`) still passes. And the URL `new URL` built is compared to the peer's
 * origin by EXACT equality, as `origin.ts` compares origins: the two regexes are the policy, this
 * is the proof the policy held.
 */
function peerUrl(origin: string, rawRest: string): URL | undefined {
  const q = rawRest.indexOf('?')
  const path = q === -1 ? rawRest : rawRest.slice(0, q)
  if (!ALLOWED_PATH.test(path)) return undefined
  if (TRAVERSAL.test(path)) return undefined
  const out = new URL(rawRest, origin)
  return out.origin === origin ? out : undefined
}
