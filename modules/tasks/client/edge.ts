/**
 * The task screen's edge to the sessions module (design D9; ADR-0021), and what it reads through it.
 *
 * `Edge` is what the shell gave this screen to reach another module, plus `where` — the translation
 * between the board's hosts and the client's (`where.ts`). `useSetups` reads the sessions module's
 * `GET setup` on every reachable host, IN PARALLEL and `SETUP_TIMEOUT_MS` each; a host that does not
 * answer in time is simply left out (design D12). Without `where` (no `GET /hosts` yet) it waits.
 */

import { useEffect, useMemo, useState } from 'preact/hooks'
import type { HostView, ViewProps } from './contract.ts'
import { captureProjects, type CaptureProject, type SetupView } from './agent-model.ts'
import { whereOf, type Where } from './where.ts'

export const SETUP_TIMEOUT_MS = 3_000

export interface Edge {
  readonly where: Where | undefined
  readonly hosts: readonly HostView[]
  readonly peerModule: ViewProps['peerModule']
  readonly openModule: ViewProps['openModule']
}

/** A promise that gives up after `ms`: the slow host is left out, never waited for. */
export function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('timeout')), ms)
    work.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (cause: unknown) => {
        window.clearTimeout(timer)
        reject(cause)
      },
    )
  })
}

/** The client's name of each reachable host: `undefined` for the one serving the app. */
function reachable(hosts: readonly HostView[]): readonly (string | undefined)[] {
  return hosts.filter((host) => host.self || host.reachable).map((host) => (host.self ? undefined : host.name))
}

export interface HostSetup {
  readonly host: string | undefined
  readonly setup: SetupView
}

/** Every reachable host's sessions setup; `undefined` until `where` exists and the reads settle. */
export function useSetups(edge: Edge): readonly HostSetup[] | undefined {
  const [setups, setSetups] = useState<readonly HostSetup[] | undefined>(undefined)
  const ready = edge.where !== undefined
  const names = reachable(edge.hosts)
  const key = names.map((name) => name ?? '').join('|')
  const { peerModule } = edge
  useEffect(() => {
    if (!ready) return
    let alive = true
    const reads = names.map(async (host): Promise<HostSetup | undefined> => {
      const api = peerModule('sessions', host)
      if (api === undefined) return undefined
      try {
        return { host, setup: await within(api.get<SetupView>('setup'), SETUP_TIMEOUT_MS) }
      } catch {
        return undefined
      }
    })
    void Promise.all(reads).then((all) => {
      if (alive) setSetups(all.filter((one): one is HostSetup => one !== undefined))
    })
    return () => {
      alive = false
    }
    // `key` stands for `names`: the same hosts, the same reads.
  }, [ready, key, peerModule])
  return setups
}

/**
 * The edge of a screen of the board, and the projects of every reachable host as the board stores
 * them — for the capture's closed list (S12) and the card's project field. `undefined` until known.
 */
export function useBoardEdge(props: ViewProps): { readonly edge: Edge; readonly hostProjects: readonly CaptureProject[] | undefined } {
  const { host, hosts, peerModule, openModule } = props
  const where = useMemo(() => whereOf(host, hosts), [host, hosts])
  const edge = useMemo<Edge>(() => ({ where, hosts, peerModule, openModule }), [where, hosts, peerModule, openModule])
  const setups = useSetups(edge)
  const hostProjects = useMemo(() => (setups === undefined || where === undefined ? undefined : captureProjects(setups, where)), [setups, where])
  return { edge, hostProjects }
}
