/**
 * The other daemon (spec 2026-10-07, D1 and D2): who it is, whether it answers, and the ONLY place
 * a URL towards it is built.
 *
 * A peer is declared in the config by its `publicOrigin`, never discovered. Its name is
 * `machineName(origin)`, and that name is what the client puts in `/h/<name>/…` and the proxy reads
 * back out of `/peers/<name>/…` — so it is checked at boot to be something a path can carry.
 */

import { z } from 'zod'
import type { Logger, PeerConfig, Timers } from '@factotum/core'

/** How often the peer is asked whether it is there (design D2). */
export const PEER_PROBE_MS = 15_000

/** How long one probe waits. A tailnet round trip is milliseconds; a sleeping Mac is forever. */
export const PEER_PROBE_TIMEOUT_MS = 3_000

/**
 * Consecutive failed probes before a peer is declared gone. ONE IS NOT ENOUGH: a probe that lands
 * while the peer restarts, or on a dropped packet, would grey out a whole host in the app and
 * make the proxy refuse it for fifteen seconds. Coming back takes one.
 */
export const PEER_DOWN_AFTER = 2

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
  /** Probes at once and then every `probeMs`, on timers the KERNEL owns (CLAUDE.md §6). */
  readonly start: (timers: Timers) => void
  /** Cancels its timers and any probe in flight. `BootHandle.stop` calls it. */
  readonly stop: () => void
}

export interface PeerTableDeps {
  readonly peers: readonly PeerConfig[]
  readonly log: Logger
  readonly now?: () => Date
  readonly probeMs?: number
  readonly probeTimeoutMs?: number
}

/**
 * What a peer's `/health` must look like to count. It is another daemon's answer, so it is
 * validated like any other input from outside (`devices` is optional: an older peer has none).
 */
const healthSchema = z.object({
  version: z.string(),
  ready: z.boolean(),
  devices: z.number().int().min(0).optional(),
})

type Health = z.infer<typeof healthSchema>

type Probe = { readonly ok: true; readonly health: Health } | { readonly ok: false; readonly reason: string }

export function createPeerTable(deps: PeerTableDeps): PeerTable {
  const now = deps.now ?? (() => new Date())
  const probeMs = deps.probeMs ?? PEER_PROBE_MS
  const probeTimeoutMs = deps.probeTimeoutMs ?? PEER_PROBE_TIMEOUT_MS

  const states = new Map<string, PeerState>(
    deps.peers.map(({ origin }) => {
      const name = machineName(origin)
      return [name, { name, origin, reachable: false, lastSeenAt: undefined, version: undefined, devices: 0 }]
    }),
  )
  /** Consecutive failures per peer. Only a run of PEER_DOWN_AFTER declares it gone. */
  const failures = new Map<string, number>()
  /** What was last LOGGED, so a line is written on a change and never on a repeat. */
  const known = new Map<string, 'up' | 'down'>()
  const inFlight = new Map<string, AbortController>()
  let armed: { readonly timers: Timers; readonly interval: Disposable } | undefined

  const update = (name: string, change: Partial<PeerState>): void => {
    const current = states.get(name)
    if (current !== undefined) states.set(name, { ...current, ...change })
  }

  const succeed = (name: string, health: Health): void => {
    failures.set(name, 0)
    update(name, { reachable: true, lastSeenAt: now().toISOString(), version: health.version, devices: health.devices ?? 0 })
    if (known.get(name) !== 'up') deps.log.info(`peer ${name} is reachable (version ${health.version})`)
    known.set(name, 'up')
  }

  const fail = (name: string, reason: string): void => {
    const count = (failures.get(name) ?? 0) + 1
    failures.set(name, count)
    if (count < PEER_DOWN_AFTER) return
    update(name, { reachable: false })
    if (known.get(name) !== 'down') deps.log.warn(`peer ${name} is unreachable: ${reason}`)
    known.set(name, 'down')
  }

  const probe = async (name: string, timers: Timers): Promise<void> => {
    const target = peerUrl(states.get(name)?.origin ?? '', '/health')
    if (target === undefined || inFlight.has(name)) return
    const controller = new AbortController()
    inFlight.set(name, controller)
    const timeout = timers.setTimeout(() => controller.abort(), probeTimeoutMs)
    try {
      const result = await askHealth(target, controller.signal, probeTimeoutMs)
      // Stopped while it was in flight: nothing is reported about a table nobody reads.
      if (armed === undefined) return
      if (result.ok) succeed(name, result.health)
      else fail(name, result.reason)
    } finally {
      timeout[Symbol.dispose]()
      inFlight.delete(name)
    }
  }

  const probeAll = (timers: Timers): void => {
    for (const name of states.keys()) void probe(name, timers)
  }

  return {
    list: () => [...states.values()],
    get: (name) => states.get(name),
    url: (name, rawRest) => {
      const peer = states.get(name)
      return peer === undefined ? undefined : peerUrl(peer.origin, rawRest)
    },
    start: (timers) => {
      if (armed !== undefined) return
      armed = { timers, interval: timers.setInterval(() => probeAll(timers), probeMs) }
      // At once: a peer that is up must not look down for the first fifteen seconds after a start.
      probeAll(timers)
    },
    stop: () => {
      armed?.interval[Symbol.dispose]()
      armed = undefined
      for (const controller of inFlight.values()) controller.abort()
    },
  }
}

/**
 * One `GET /health`. NEVER THROWS: every way it can go wrong is a reason. No `Origin` — this is a
 * daemon, not a browser — and redirects are not followed: a peer that redirects is not a peer.
 */
async function askHealth(target: URL, signal: AbortSignal, timeoutMs: number): Promise<Probe> {
  try {
    const response = await fetch(target, { redirect: 'manual', signal, headers: { accept: 'application/json' } })
    if (response.status !== 200) {
      await response.body?.cancel()
      return { ok: false, reason: `its /health answered ${response.status}` }
    }
    const parsed = healthSchema.safeParse(await response.json().catch(() => undefined))
    if (!parsed.success) return { ok: false, reason: 'its /health is not a factotum answer' }
    if (!parsed.data.ready) return { ok: false, reason: 'it is still starting' }
    return { ok: true, health: parsed.data }
  } catch {
    // The reason, never the error's message: it can carry the URL, and the URL is in the config.
    return { ok: false, reason: signal.aborted ? `no answer within ${timeoutMs}ms` : 'no answer' }
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
