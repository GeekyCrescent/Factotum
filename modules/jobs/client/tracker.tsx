/**
 * The tracker of this cut, `/m/jobs` (spec 2026-11-12-postulaciones, task R7; design D15 «Tracker»;
 * requirements crit. 63): the warnings of `health()`, the counters, and «Start review (N)» — or
 * «Continue review» with a batch open, which is never armed over. The list of applications, the
 * filters and the detail are T2a's.
 *
 * THE SENDS THAT NEED THE OWNER are here too, one card per send («did it go?», failed): after a
 * restart, the review's bar no longer has them, and this is where they are answered. Their answers go
 * through this screen's one lock, as in the review.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { BatchAnswer, Overview, ViewProps } from './contract.ts'
import { createLock, runOrSay } from './guard.ts'
import { refusalOf } from './model.ts'
import { SendLines } from './send-lines.tsx'
import { countersOf, startOf } from './tracker-model.ts'
import { useSends } from './use-sends.ts'

export function Tracker({ props }: { readonly props: ViewProps }) {
  const { api, navigate } = props
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const lock = useMemo(createLock, [])
  const sends = useSends(api, lock)
  const { seed } = sends

  /** Unmounted: a read that answers later draws nothing. */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const read = await api.get<Overview>('overview')
      if (!alive.current) return
      setOverview(read)
      seed(read.sends)
      setError(null)
    } catch (cause) {
      if (alive.current) setError(refusalOf(cause).text)
    }
  }, [api, seed])
  useEffect(() => void load(), [load])
  // The sends are seeded once per read: back on the screen, read again, so a send that needs the owner
  // since — or one answered on another device — is drawn as it is now (`use-sends.ts` reads its lines).
  useEffect(() => {
    const again = (): void => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', again)
    return () => document.removeEventListener('visibilitychange', again)
  }, [load])

  const start = async (): Promise<void> => {
    if (overview === null) return
    const plan = startOf(overview)
    if (!plan.enabled) return
    if (!plan.arms) {
      navigate('review')
      return
    }
    await runOrSay(lock, async () => {
      setBusy(true)
      try {
        await api.post<BatchAnswer>('batch')
        navigate('review')
      } catch (cause) {
        setError(refusalOf(cause).text)
      } finally {
        setBusy(false)
      }
    }, setError)
  }

  const plan = overview === null ? null : startOf(overview)
  return (
    <div class="j-screen">
      <header class="j-review-bar">
        <p class="j-crumb">Jobs</p>
        <SendLines sends={sends} busy={busy || sends.acting} />
      </header>
      <main class="j-tracker">
        {error === null ? null : (
          <div class="notice err" role="alert">
            <p>{error}</p>
          </div>
        )}
        {overview?.missingPhone === true ? (
          <div class="notice err">
            <p role="alert">Your profile has no phone: nothing becomes ready to send, and the package is not imported.</p>
            <div class="acts">
              <button type="button" class="btn sm" onClick={() => navigate('settings#phone')}>
                Add your phone
              </button>
            </div>
          </div>
        ) : null}
        {overview?.notices.map((text) => (
          <div key={text} class="notice ask">
            <p>{text}</p>
          </div>
        ))}
        {overview === null ? (
          error === null ? <p class="j-loading">Loading…</p> : null
        ) : (
          <ul class="j-counters">
            {countersOf(overview).map((counter) => (
              <li key={counter.label} class="j-counter">
                <span class="j-counter-value num">{counter.value}</span>
                <span class="j-counter-label">{counter.label}</span>
              </li>
            ))}
          </ul>
        )}
        <div class="j-tracker-acts">
          {plan === null ? null : (
            <button type="button" class="btn primary decide" disabled={busy || sends.acting || !plan.enabled} onClick={() => void start()}>
              {plan.label}
            </button>
          )}
          <button type="button" class="btn" onClick={() => navigate('settings')}>
            Settings
          </button>
        </div>
      </main>
    </div>
  )
}
