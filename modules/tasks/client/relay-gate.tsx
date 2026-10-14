/**
 * Relay mode on the screen (design D12; criterion 29b): a host that keeps no board — the Mac — shows
 * «Tasks» in its drawer like any other, and this gate takes the owner to the board where it lives.
 *
 * IT ASKS `GET /where` ALONGSIDE THE SCREEN, not before it: on the board's own host (the usual case)
 * the board loads with no extra wait, and the answer `board` changes nothing. On a relay:
 * - `relayTo` is another host → the board's screen through the proxy (`/h/<host>/m/tasks`);
 * - `relayTo` is the host serving the app → the same screen without the `/h/` (never `/peers/<self>/`);
 * - that host is not in `hosts`, or is not reachable → «The board lives on <host>, which is unreachable»,
 *   and nothing is left loading.
 * No `ctx.peers` is involved: it is the client that crosses.
 */

import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import type { WhereView } from '../types.ts'
import { PageBar } from './bar.tsx'
import type { ViewProps } from './contract.ts'
import { relayTarget } from './where.ts'

export function RelayGate({ props, children }: { readonly props: ViewProps; readonly children: ComponentChildren }) {
  const { api, navigate, hosts } = props
  const [where, setWhere] = useState<WhereView | undefined>(undefined)

  useEffect(() => {
    let alive = true
    api
      .get<WhereView>('where')
      .then((answer) => alive && setWhere(answer))
      // An old daemon without the route, or one that is starting: the screen it already shows stands.
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api])

  const relayTo = where?.mode === 'relay' ? where.host : undefined
  const target = relayTo === undefined ? undefined : relayTarget(relayTo, hosts)
  useEffect(() => {
    if (relayTo === undefined || target === undefined) return
    if (target.kind === 'self') navigate('', { host: null, replace: true })
    else if (target.kind === 'peer') navigate('', { host: relayTo, replace: true })
  }, [relayTo, target?.kind, navigate])

  if (relayTo === undefined) return <>{children}</>
  if (target?.kind === 'unreachable') {
    return (
      <div class="t-screen">
        <PageBar title="Tasks" back={{ label: 'Retry', go: () => window.location.reload() }} pendingTotal={props.pendingTotal} onMenu={props.openDrawer} />
        <div class="t-pad">
          <div class="notice ask" role="alert">
            <div class="head">The board lives on {relayTo}, which is unreachable</div>
            <p>This host keeps no board of its own. When {relayTo} is back, Tasks opens it.</p>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div class="t-screen">
      <div class="t-loading dim-3 t-pad" role="status">
        Going to the board on {relayTo}…
      </div>
    </div>
  )
}
