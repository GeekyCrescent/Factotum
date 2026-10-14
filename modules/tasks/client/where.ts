/**
 * Which host is `null` (design D9, «Qué host es null»; criterion 30b). PURE.
 *
 * TWO NAMING SYSTEMS MEET HERE, and only here:
 * - what the BOARD stores (`project.host`, `sessions[].host`, `source.host`): `null` is the board's host;
 * - what the CLIENT speaks (`peerModule`, `openModule`, `apiOn`, `props.host`): `undefined` is the host
 *   serving the app.
 * They stopped being the same the day the Mac's app showed omarchy's board through the proxy. Every
 * `host` the task screen reads or writes goes through these two functions.
 */

export interface Where {
  /** `props.host` of the board's screen: `undefined` when the app is served by the board's own host. */
  readonly boardHost: string | undefined
  /** The host serving the app: `hosts.find(h => h.self).name`. */
  readonly selfName: string
}

/** Nothing until `GET /hosts` has answered: who needs a host waits for it. */
export function whereOf(boardHost: string | undefined, hosts: readonly { readonly name: string; readonly self: boolean }[]): Where | undefined {
  const self = hosts.find((host) => host.self)
  if (self === undefined) return undefined
  // `/h/<self>/m/tasks` is the serving host by another name: it is `undefined` in the client's language.
  return { boardHost: boardHost === self.name ? undefined : boardHost, selfName: self.name }
}

/** From what is stored to what the client understands. */
export function toClientHost(stored: string | null, where: Where): string | undefined {
  if (stored === null) return where.boardHost
  return stored === where.selfName ? undefined : stored
}

/** From what the client chose to what is stored. */
export function toStoredHost(chosen: string | undefined, where: Where): string | null {
  const name = chosen ?? where.selfName
  const board = where.boardHost ?? where.selfName
  return name === board ? null : name
}

export type RelayTarget = { readonly kind: 'self' } | { readonly kind: 'peer' } | { readonly kind: 'unreachable' }

/**
 * Where a relay sends the screen (crit. 29b): the serving host itself, the other host through the
 * proxy, or nowhere because that host is down or not one of this app's. `undefined` until `hosts`.
 */
export function relayTarget(
  relayTo: string,
  hosts: readonly { readonly name: string; readonly self: boolean; readonly reachable: boolean }[],
): RelayTarget | undefined {
  if (hosts.length === 0) return undefined
  const host = hosts.find((h) => h.name === relayTo)
  if (host === undefined) return { kind: 'unreachable' }
  if (host.self) return { kind: 'self' }
  return host.reachable ? { kind: 'peer' } : { kind: 'unreachable' }
}
