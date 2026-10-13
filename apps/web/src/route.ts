/**
 * What followed `/m/<id>` in the path, for a module screen to land somewhere deeper than its root.
 *
 * In a `.ts` and not in `shell.tsx` because `node --test` strips types but does not transform
 * JSX: anything here has to be importable by a test.
 */

/**
 * `/m/sessions/019a…` → `019a…`; `/m/sessions` and `/m/sessions/` → `''`. A screen of another host,
 * `/h/<host>/m/…`, has the same rest: the host is not the module's to read (spec
 * 2026-10-07-dos-hosts, design D12).
 */
export function restOf(fullPath: string, id: string): string {
  const path = fullPath.replace(HOST_PREFIX, '')
  const prefix = `/m/${id}`
  if (path === prefix || path === `${prefix}/`) return ''
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : ''
}

/** A leading `/h/<host>`, followed by more path. */
const HOST_PREFIX = /^\/h\/[^/]+(?=\/)/
