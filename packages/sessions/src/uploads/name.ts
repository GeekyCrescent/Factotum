/**
 * The name an upload is kept under. PURE.
 *
 * It comes from outside — the phone, Finder — and it becomes a path under `uploads/<id>/` AND a
 * piece of the prompt, as `@<path>`. The second is why the alphabet is closed and a space is never
 * kept: a space in `@<path>` splits the reference in two (spec 2026-10-01, D5; inherited from the
 * predecessor's attachments).
 *
 * A SEPARATOR IS REFUSED, NOT CLEANED. `a/b.png` sanitised to `a-b.png` would keep a file nobody
 * asked for; refusing keeps the 400 meaning something. The id folder is what isolates an upload, not
 * the name.
 */

/** The longest name kept, extension included. */
export const UPLOAD_NAME_MAX = 120

/** An extension longer than this is not treated as one when cutting: the whole name is cut. */
const EXTENSION_MAX = 16

export type SanitizedName = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly reason: string }

const OUTSIDE = /[^A-Za-z0-9._-]/gu

function tidy(value: string): string {
  return value
    .replace(OUTSIDE, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-+$/, '')
    .replace(/-+\.(?=[^.]*$)/, '.')
}

function cut(name: string): string {
  if (name.length <= UPLOAD_NAME_MAX) return name
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot) : ''
  if (extension === '' || extension.length > EXTENSION_MAX) return name.slice(0, UPLOAD_NAME_MAX).replace(/[.-]+$/, '')
  const base = name.slice(0, UPLOAD_NAME_MAX - extension.length).replace(/[.-]+$/, '')
  return `${base}${extension}`
}

export function sanitizeName(raw: string): SanitizedName {
  if (raw === '' || raw === '.' || raw === '..') return { ok: false, reason: 'a file needs a name' }
  if (raw.includes('/') || raw.includes('\\')) return { ok: false, reason: 'a file name cannot contain a slash' }
  const name = cut(tidy(raw.normalize('NFC')))
  if (name === '' || /^\.*$/.test(name)) return { ok: false, reason: 'that file name has nothing that can be kept' }
  return { ok: true, name }
}

/** Is this exactly what `sanitizeName` keeps? How a name in a URL is checked before it forms a path. */
export function isSanitizedName(value: string): boolean {
  const result = sanitizeName(value)
  return result.ok && result.name === value
}
