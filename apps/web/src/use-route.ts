/**
 * The route, the overlay on top of it and the one-use query, kept in step with `window.history`.
 *
 * Every decision is in `router.ts`, with tests; this only applies them. The functions it returns are
 * STABLE for the life of the page: modules receive them as props, and an effect keyed on one must
 * not re-run on every render of the shell.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { historyStep, locationOf, navigateTarget, onLoad, overlayOf, screenOf, type HistoryState, type Screen } from './router.ts'

export interface Route {
  readonly screen: Screen
  readonly overlay: string | undefined
  /** The query the page loaded with, until the first navigation. `''` after it (design D4). */
  readonly search: string
  /** To another screen. With an overlay on top, its entry is replaced, so Back skips it. */
  readonly go: (path: string, options?: { readonly replace?: boolean }) => void
  /** Where `/` lands: replaces the entry and keeps the query for the screen it lands on. */
  readonly land: (path: string) => void
  readonly openOverlay: (name: string) => void
  /** Through `history.back()` when the overlay has its own entry, so Back and ✕ do the same. */
  readonly closeOverlay: () => void
}

/**
 * BEFORE THE FIRST RENDER (spec §0.17): the query leaves the address bar, and an overlay is never
 * restored. Returns the query, for the first screen and nobody else.
 */
export function takeLoad(): string {
  const loaded = onLoad(window.location, topState())
  if (loaded.replaceWith !== undefined) window.history.replaceState(loaded.replaceWith.state, '', loaded.replaceWith.path)
  return loaded.search
}

export function useRoute(initialSearch: string): Route {
  const [path, setPath] = useState(window.location.pathname)
  const [overlay, setOverlay] = useState<string | undefined>(overlayOf(window.history.state))
  const [search, setSearch] = useState(initialSearch)
  const current = useRef(path)
  current.current = path

  const actions = useMemo(() => {
    const apply = (to: string, replace: boolean) => {
      const step = historyStep(topState(), { path: to, replace })
      if (step.op === 'push') window.history.pushState(step.state, '', step.path)
      else window.history.replaceState(step.state, '', step.path)
      setPath(step.path)
      setOverlay(undefined)
    }
    return {
      go: (to: string, options?: { readonly replace?: boolean }) => {
        apply(to, options?.replace === true)
        setSearch('')
      },
      land: (to: string) => apply(to, true),
      openOverlay: (name: string) => {
        const top = overlayOf(window.history.state)
        if (top === name) return
        // One overlay entry at a time: a second replaces the first instead of stacking.
        if (top === undefined) window.history.pushState({ overlay: name }, '', window.location.pathname)
        else window.history.replaceState({ overlay: name }, '', window.location.pathname)
        setOverlay(name)
      },
      closeOverlay: () => {
        if (overlayOf(window.history.state) !== undefined) window.history.back()
        else setOverlay(undefined)
      },
      /** The worker delivered a notification to this open window: exactly like a load (design D4). */
      arrive: (to: string) => {
        const loaded = onLoad(locationOf(to), null)
        apply(locationOf(to).pathname, false)
        setSearch(loaded.search)
      },
    }
  }, [])

  useEffect(() => {
    const onPop = () => {
      const next = window.location.pathname
      if (next !== current.current) setSearch('')
      setPath(next)
      setOverlay(overlayOf(window.history.state))
    }
    const onMessage = (event: MessageEvent) => {
      const to = navigateTarget(event.data)
      if (to !== undefined) actions.arrive(to)
    }
    window.addEventListener('popstate', onPop)
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('popstate', onPop)
      navigator.serviceWorker?.removeEventListener('message', onMessage)
    }
  }, [actions])

  return {
    screen: screenOf(path),
    overlay,
    search,
    go: actions.go,
    land: actions.land,
    openOverlay: actions.openOverlay,
    closeOverlay: actions.closeOverlay,
  }
}

/** `history.state`, read through `overlayOf`: whatever a page stored there is not trusted. */
function topState(): HistoryState | null {
  const overlay = overlayOf(window.history.state)
  return overlay === undefined ? null : { overlay }
}
