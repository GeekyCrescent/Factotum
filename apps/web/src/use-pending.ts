/**
 * The live pendings, read from what the worker stored (design D7).
 *
 * Read at start, when the worker says one arrived, and when the page comes back to the front. The
 * expired ones are deleted here; a module deletes what it knows is over through `resolve`. A timer
 * set to the next deadline keeps the ☰ count from showing something already over.
 *
 * NO CONSOLE (criterion 37): a record may hold an ask token.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { allPending, removePending } from './pending-db.ts'
import { alive, keyOf, nextExpiry, type Pending } from './pending.ts'

/** How long to buzz for a new pending (design D6). A tap, not an alarm. */
const VIBRATE_MS = 30
/** Past a deadline by this much before reading again, so the pending is surely expired. */
const EXPIRY_MARGIN_MS = 250
/** `setTimeout` overflows past 2^31-1 ms and fires at once; nothing waits that long anyway. */
const MAX_TIMER_MS = 2_147_483_647

export interface Pendings {
  readonly all: readonly Pending[]
  readonly resolve: (moduleId: string, tag: string) => void
}

export function usePending(): Pendings {
  const [all, setAll] = useState<readonly Pending[]>([])
  const known = useRef<readonly Pending[]>([])
  known.current = all

  const actions = useMemo(() => {
    const refresh = async () => {
      const split = alive(await allPending(), Date.now())
      if (split.expired.length > 0) await removePending(split.expired.map((record) => record.key))
      setAll(split.alive)
    }
    const resolve = (moduleId: string, tag: string) => {
      const key = keyOf(moduleId, tag)
      // Unchanged when it is not there, so a module that resolves on every render does not loop.
      setAll((current) => (current.some((record) => record.key === key) ? current.filter((record) => record.key !== key) : current))
      void removePending([key])
    }
    return { refresh, resolve }
  }, [])

  useEffect(() => {
    void actions.refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void actions.refresh()
    }
    const onMessage = (event: MessageEvent) => {
      const key = pendingKey(event.data)
      if (key === undefined) return
      if (!known.current.some((record) => record.key === key)) buzz()
      void actions.refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      navigator.serviceWorker?.removeEventListener('message', onMessage)
    }
  }, [actions])

  useEffect(() => {
    const wait = nextExpiry(all, Date.now())
    if (wait === undefined) return undefined
    const timer = setTimeout(() => void actions.refresh(), Math.min(wait + EXPIRY_MARGIN_MS, MAX_TIMER_MS))
    return () => clearTimeout(timer)
  }, [all, actions])

  return { all, resolve: actions.resolve }
}

function pendingKey(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const { type, key } = data as Record<string, unknown>
  return type === 'pending' && typeof key === 'string' ? key : undefined
}

/**
 * Once, for a NEW pending, with the page in front and after the owner has touched it: a browser
 * ignores `vibrate` before any user activation, and a buzz from a hidden page means nothing.
 */
function buzz(): void {
  const activation = (navigator as { readonly userActivation?: { readonly hasBeenActive: boolean } }).userActivation
  if (document.visibilityState !== 'visible' || activation?.hasBeenActive !== true) return
  navigator.vibrate?.(VIBRATE_MS)
}
