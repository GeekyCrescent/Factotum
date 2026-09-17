/**
 * What followed `/m/<id>` in the path, for a module screen to land somewhere deeper than its root.
 *
 * In a `.ts` and not in `shell.tsx` because `node --test` strips types but does not transform
 * JSX: anything here has to be importable by a test.
 */

/** `/m/sessions/019a…` → `019a…`; `/m/sessions` and `/m/sessions/` → `''`. */
export function restOf(path: string, id: string): string {
  const prefix = `/m/${id}`
  if (path === prefix || path === `${prefix}/`) return ''
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : ''
}
