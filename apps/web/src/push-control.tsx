/**
 * The notifications switch on the home screen.
 *
 * THE PERMISSION IS REQUESTED FROM THE CLICK AND FROM NOWHERE ELSE. On load it only reads.
 *
 * THE COUNT IS THE DETECTION. The subscription route has no credential, so anything on the
 * daemon's machine can register a device (docs/networking.md). A new device is announced to the
 * existing ones — but the very first device on a fresh daemon has nobody to be announced to.
 * What covers that case is this screen showing how many devices the machine has right after
 * you subscribe: expecting 1 and seeing 2 is how you find out.
 */

import { useEffect, useState } from 'preact/hooks'
import { fetchPushPublicKey, postPushSubscription } from './api.ts'
import { enablePush, readPushState, type PushApi, type PushState } from './push.ts'

const api: PushApi = { publicKey: fetchPushPublicKey, subscribe: postPushSubscription }

export function PushControl() {
  const [state, setState] = useState<PushState | undefined>(undefined)
  const [count, setCount] = useState<number | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void readPushState().then(setState)
  }, [])

  const turnOn = async () => {
    setBusy(true)
    const result = await enablePush(api)
    setState(result.state)
    setCount(result.count)
    setError(result.error)
    setBusy(false)
  }

  if (state === undefined) return null

  return (
    <section class="push">
      <h2>Notifications</h2>
      {state.kind === 'unsupported' ? <p>Unavailable here: {state.why}.</p> : null}
      {state.kind === 'denied' ? (
        <p>Blocked for this site. Allow notifications in the browser's settings for this address, then come back.</p>
      ) : null}
      {state.kind === 'off' ? (
        <button type="button" disabled={busy} onClick={() => void turnOn()}>
          {busy ? 'Turning on…' : 'Turn on notifications'}
        </button>
      ) : null}
      {state.kind === 'on' ? (
        <>
          <p>On for this device.</p>
          {count === undefined ? (
            <button type="button" disabled={busy} onClick={() => void turnOn()}>
              How many devices does this machine have?
            </button>
          ) : (
            <p>
              This machine has <strong>{count}</strong> subscribed device{count === 1 ? '' : 's'}.
              {count > 1 ? (
                <>
                  {' '}If that is more than you set up, run <code>factotum push reset</code> on that machine.
                </>
              ) : null}
            </p>
          )}
        </>
      ) : null}
      {error !== undefined ? <p class="error">{error}</p> : null}
    </section>
  )
}
