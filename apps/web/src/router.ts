/**
 * What the URL means, and what to do with the history — pure, so a test can drive it.
 *
 * THE SHELL KNOWS NO MODULE BY NAME, and neither does this: a screen is `/m/<id>/<rest>`,
 * `/h/<host>/m/<id>/<rest>` (the same screen on another host, spec 2026-10-07-dos-hosts, design D12),
 * `/settings` or `/`. `/device`, the settings page's old address, still leads there. `/` resolves to the first enabled module by `nav.order`, decided by the caller.
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
  | { readonly kind: 'settings' }
  /** `host` only under `/h/<host>/`: absent, the screen is the serving host's. */
  | { readonly kind: 'module'; readonly id: string; readonly rest: string; readonly host?: string }
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
const RESERVED = /^\/(modules|push|health|hosts|peers)(\/|$)/

/** `/m/<id>`, or `/h/<host>/m/<id>`, then `/` or the end. */
const MODULE = /^(?:\/h\/([^/]+))?\/m\/([^/]+)(?:\/|$)/

export function screenOf(pathname: string): Screen {
  if (pathname === '/' || pathname === '') return { kind: 'root' }
  if (RESERVED.test(pathname)) return { kind: 'unknown', path: pathname }
  if (/^\/(settings|device)\/?$/.test(pathname)) return { kind: 'settings' }
  const m = MODULE.exec(pathname)
  if (m !== null) {
    const [, host, rawId = ''] = m
    const screen = { kind: 'module', id: decodeURIComponent(rawId), rest: restOf(pathname, rawId) } as const
    return host === undefined ? screen : { ...screen, host: decodeURIComponent(host) }
  }
  return { kind: 'unknown', path: pathname }
}

export function pathOf(screen: Screen): string {
  switch (screen.kind) {
    case 'root':
      return '/'
    case 'settings':
      return '/settings'
    case 'module': {
      const host = screen.host === undefined ? '' : `/h/${encodeURIComponent(screen.host)}`
      const base = `${host}/m/${encodeURIComponent(screen.id)}`
      return screen.rest === '' ? base : `${base}/${screen.rest}`
    }
    case 'unknown':
      return screen.path
  }
}

/**
 * What a module's `navigate` takes (design D12). `host`: a name goes to that host, `null` back to the
 * one serving the app, and WITHOUT THE KEY it stays where it is. `replace` leaves no history entry.
 */
export interface NavigateOptions {
  readonly replace?: boolean
  readonly host?: string | null
}

/**
 * The path a module's `navigate(rest, options)` leads to, from a screen on `current` (`undefined`:
 * the serving host — always, in the drawer, which belongs to the whole app).
 */
export function navigatePath(id: string, rest: string, current: string | undefined, options?: NavigateOptions): string {
  const host = options?.host === undefined ? current : (options.host ?? undefined)
  return pathOf(host === undefined ? { kind: 'module', id, rest } : { kind: 'module', id, rest, host })
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
