/**
 * Is this a picture a browser may paint? Decided by the FIRST BYTES, never by a name.
 *
 * Four raster formats and nothing else. The kernel serves a module's file `inline` only when this
 * says so (spec 2026-10-01, D3), and the sessions engine uses the same answer to say "image" about
 * an upload — one rule for "this is painted", in the one package both depend on.
 *
 * SVG IS NOT HERE, ON PURPOSE. It is a document that runs scripts, and the origin it would be served
 * from is the one that approves permissions. An HTML file renamed `.png` is not here either: the
 * extension never counts.
 *
 * Pure, and `node:`-free, like the rest of core.
 */

export type RasterType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/** How many leading bytes `rasterTypeOf` needs to decide. Fewer is never a picture. */
export const SNIFF_BYTES = 12

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const JPEG = [0xff, 0xd8, 0xff] as const
const GIF = [0x47, 0x49, 0x46, 0x38] as const
const RIFF = [0x52, 0x49, 0x46, 0x46] as const
const WEBP = [0x57, 0x45, 0x42, 0x50] as const

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  if (bytes.length < at + signature.length) return false
  return signature.every((byte, i) => bytes[at + i] === byte)
}

export function rasterTypeOf(bytes: Uint8Array): RasterType | undefined {
  if (startsWith(bytes, PNG)) return 'image/png'
  if (startsWith(bytes, JPEG)) return 'image/jpeg'
  if (startsWith(bytes, GIF)) return 'image/gif'
  // RIFF, four bytes of size, then WEBP.
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'image/webp'
  return undefined
}
