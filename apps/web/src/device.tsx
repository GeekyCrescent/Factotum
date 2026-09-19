/**
 * Device: notifications for this browser, how many devices the machine holds, and the daemon.
 *
 * THE PERMISSION IS REQUESTED FROM THE CLICK AND FROM NOWHERE ELSE. On load it only reads.
 *
 * THE COUNT IS THE DETECTION. The subscription route has no credential, so anything on the
 * daemon's machine can register a device (docs/networking.md). A new device is announced to the
 * existing ones, but the very first device on a fresh daemon has nobody to be announced to. What
 * covers that case is this page showing how many devices the machine has: expecting 1 and seeing 2
 * is how you find out. The shell re-posts the subscription at start (design D12), so the count is
 * usually here without a tap.
 */

import { useEffect, useState } from 'preact/hooks'
import { fetchPushPublicKey, postPushSubscription } from './api.ts'
import { FallbackBar } from './bar.tsx'
import { Icon } from './icon.tsx'
import { writeSettings } from './pending-db.ts'
import { enablePush, readPushState, type EnableResult, type PushApi, type PushState } from './push.ts'

export const PUSH_API: PushApi = { publicKey: fetchPushPublicKey, subscribe: postPushSubscription }

/** Criterion 29's other half: a browser here would keep the token where an agent can read it. */
const SAME_MACHINE_WARNING =
  'A browser on this machine should not subscribe: pending approvals are kept on the device, and an agent here can read them.'

/**
 * What the daemon said about this subscription goes where the worker reads it (design D7, D12).
 * Unknown stays unknown: the worker then keeps no token, which is the safe side.
 */
export function rememberPush(result: EnableResult): void {
  if (result.sameMachine !== undefined) void writeSettings({ sameMachine: result.sameMachine })
}

export function Device({
  push,
  onPush,
  pendingTotal,
  openDrawer,
}: {
  /** What the last subscription call said: the start-up re-post, or the button here. */
  readonly push: EnableResult | undefined
  readonly onPush: (result: EnableResult) => void
  readonly pendingTotal: number
  readonly openDrawer: () => void
}) {
  const [state, setState] = useState<PushState | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void readPushState().then((read) => {
      if (live) setState(read)
    })
    return () => {
      live = false
    }
  }, [])

  const turnOn = async () => {
    setBusy(true)
    const result = await enablePush(PUSH_API)
    setState(result.state)
    onPush(result)
    setBusy(false)
  }

  const count = state?.kind === 'on' ? push?.count : undefined

  return (
    <>
      <FallbackBar title="This device" pendingTotal={pendingTotal} onMenu={openDrawer} />
      <div class="page">
        <div class="group">
          <div class="cell">
            <Icon name="bell" />
            <span class="k">Notifications</span>
            <NotificationsControl state={state} busy={busy} turnOn={() => void turnOn()} />
            <span class="v">{describe(state)}</span>
          </div>
          {state?.kind === 'on' ? (
            <div class="cell">
              <Icon name="devices" />
              <span class="k">Subscribed devices</span>
              {count === undefined ? (
                <button type="button" class="btn sm quiet" disabled={busy} onClick={() => void turnOn()}>
                  Count
                </button>
              ) : (
                <span class="big">{count}</span>
              )}
              <span class="v">
                {push?.sameMachine === true ? 'One of them is this machine. ' : ''}
                The count this machine holds. If it is more than you set up, run <span class="mono">factotum push reset</span> there.
              </span>
            </div>
          ) : null}
        </div>
        {push?.sameMachine === true ? (
          <div class="notice ask" role="status">
            <div class="head">
              <Icon name="hard-drives" />
              This browser runs on the daemon's machine
            </div>
            <p>{SAME_MACHINE_WARNING}</p>
          </div>
        ) : state?.kind === 'on' ? (
          <p class="dim-3">{SAME_MACHINE_WARNING}</p>
        ) : null}
        {push?.error !== undefined ? (
          <div class="notice err" role="alert">
            <p>{push.error}</p>
          </div>
        ) : null}
        <div class="group">
          <div class="cell">
            <Icon name="hard-drives" />
            <span class="k">Daemon</span>
            <span class="ok">Ready</span>
            <span class="v mono">{window.location.host}</span>
          </div>
        </div>
      </div>
    </>
  )
}

function NotificationsControl({
  state,
  busy,
  turnOn,
}: {
  readonly state: PushState | undefined
  readonly busy: boolean
  readonly turnOn: () => void
}) {
  switch (state?.kind) {
    case 'on':
      return <span class="ok">On</span>
    case 'off':
      return (
        <button type="button" class="btn sm primary" disabled={busy} onClick={turnOn}>
          {busy ? 'Turning on…' : 'Turn on'}
        </button>
      )
    case 'denied':
      return <span class="warn">Blocked</span>
    case 'unsupported':
      return <span class="dim-3">Unavailable</span>
    default:
      return <span />
  }
}

function describe(state: PushState | undefined): string {
  switch (state?.kind) {
    case 'on':
      return 'On for this device. Asks and finished turns arrive here.'
    case 'off':
      return 'Asks and finished turns arrive here once this is on.'
    case 'denied':
      return "Blocked for this site. Allow notifications in the browser's settings for this address, then come back."
    case 'unsupported':
      return `Unavailable here: ${state.why}.`
    default:
      return 'Reading this browser.'
  }
}
