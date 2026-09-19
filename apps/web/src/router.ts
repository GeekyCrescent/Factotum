/**
 * What the URL means, and what to do with the history — pure, so a test can drive it.
 *
 * THE SHELL KNOWS NO MODULE BY NAME, and neither does this: a screen is `/m/<id>/<rest>`, `/device`
 * or `/`. `/` resolves to the first enabled module by `nav.order`, decided by the caller.
 *
 * THE QUERY IS ONE-USE (spec 2026-09-18, §0.17 and supposition 13). A page loads with its query —
 * a notification's `?ask=<token>` — and the shell takes it OUT of the address bar before the first
 * render, handing it to the module once. Removing it later, from a module's effect, is too late: a
 * child that opens a sheet with pushState has already copied the URL, token and all, into a new
 * history entry. The shell does not know what `ask` is; it removes the whole query.
 */

import { restOf } from './route.ts'

export type Screen =
  | { readonly kind: 'root' }
  | { readonly kind: 'device' }
  | { readonly kind: 'module'; readonly id: string; readonly rest: string }
  | { readonly kind: 'unknown'; readonly path: string }

export interface HistoryState {
  readonly overlay?: string
}

/** The overlay a history entry carries. `history.state` is anything a page ever stored: checked. */
export function overlayOf(state: unknown): string | undefined {
  if (state === null || typeof state !== 'object') return undefined
  const overlay = (state as Record<string, unknown>)['overlay']
  return typeof overlay === 'string' ? overlay : undefined
}

/** Paths the client never owns: the kernel's and the static files'. */
const RESERVED = /^\/(modules|push|health)(\/|$)/

export function screenOf(pathname: string): Screen {
  if (pathname === '/' || pathname === '') return { kind: 'root' }
  if (RESERVED.test(pathname)) return { kind: 'unknown', path: pathname }
  if (pathname === '/device' || pathname === '/device/') return { kind: 'device' }
  const m = /^\/m\/([^/]+)(?:\/|$)/.exec(pathname)
  if (m !== null) return { kind: 'module', id: decodeURIComponent(m[1] ?? ''), rest: restOf(pathname, m[1] ?? '') }
  return { kind: 'unknown', path: pathname }
}

export function pathOf(screen: Screen): string {
  switch (screen.kind) {
    case 'root':
      return '/'
    case 'device':
      return '/device'
    case 'module':
      return screen.rest === '' ? `/m/${encodeURIComponent(screen.id)}` : `/m/${encodeURIComponent(screen.id)}/${screen.rest}`
    case 'unknown':
      return screen.path
  }
}

export interface Loaded {
  /** Replace the current entry with this, BEFORE the first render. `undefined`: nothing to clean. */
  readonly replaceWith: { readonly path: string; readonly state: null } | undefined
  /** The query the page loaded with, handed to the screen once. `''` when there was none. */
  readonly search: string
}

/**
 * At load — or when the worker delivers a notification to an open window (design D4): take the
 * query out, and never restore an overlay (a reload with the drawer open opens it closed).
 */
export function onLoad(location: { readonly pathname: string; readonly search: string }, state: HistoryState | null): Loaded {
  const hasQuery = location.search !== '' && location.search !== '?'
  const hasOverlay = state !== null && typeof state === 'object' && state.overlay !== undefined
  return {
    replaceWith: hasQuery || hasOverlay ? { path: location.pathname, state: null } : undefined,
    search: hasQuery ? location.search : '',
  }
}

export interface Step {
  readonly op: 'push' | 'replace'
  readonly path: string
  readonly state: null
}

/**
 * Navigating. With an overlay on top (the drawer, a sheet), the overlay's entry is REPLACED by the
 * destination, so Back goes to where you were before opening it — with the overlay closed.
 */
export function historyStep(top: HistoryState | null, to: { readonly path: string; readonly replace?: boolean }): Step {
  const overlayOnTop = top !== null && typeof top === 'object' && top.overlay !== undefined
  return { op: to.replace === true || overlayOnTop ? 'replace' : 'push', path: to.path, state: null }
}

/** Splits a path the worker hands over into what `onLoad` takes. */
export function locationOf(path: string): { readonly pathname: string; readonly search: string } {
  const at = path.indexOf('?')
  return at < 0 ? { pathname: path, search: '' } : { pathname: path.slice(0, at), search: path.slice(at) }
}

/** `{ type: 'navigate', path }` from the worker, with a path on this origin; anything else is ignored. */
export function navigateTarget(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const { type, path } = data as Record<string, unknown>
  if (type !== 'navigate' || typeof path !== 'string') return undefined
  return path.startsWith('/') && !path.startsWith('//') ? path : undefined
}
