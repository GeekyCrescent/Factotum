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
  return self === undefined ? undefined : { boardHost, selfName: self.name }
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
