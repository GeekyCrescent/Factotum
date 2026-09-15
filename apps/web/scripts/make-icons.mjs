/**
 * The two PWA icons, generated rather than committed as binaries nobody can edit.
 *
 * `node apps/web/scripts/make-icons.mjs` rewrites `public/icon-192.png` and
 * `public/icon-512.png`. It runs by hand, not in the build: the icons change about
 * never, and a build step that rewrites tracked files makes every `git status` lie.
 *
 * A minimal PNG encoder, because a picture of a lowercase `f` is not worth a
 * dependency — and `zlib` is already in Node.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

/** The theme colour of the shell (`manifest.json`), so the icon matches the app. */
const BACKGROUND = [17, 17, 17]
const FOREGROUND = [245, 245, 245]

/**
 * The glyph, in fractions of the icon's side: a lowercase `f` as three rectangles.
 *
 * Everything sits inside the middle 50%, which is what `purpose: "maskable"` needs:
 * Android may crop the icon to a circle, and anything outside the safe zone — the
 * centred circle of 80% diameter — is what gets cut off.
 */
const GLYPH = [
  { x: 0.42, y: 0.28, w: 0.1, h: 0.44 }, // the stem
  { x: 0.42, y: 0.28, w: 0.22, h: 0.09 }, // the hook, which has to reach well right
  { x: 0.34, y: 0.45, w: 0.22, h: 0.08 }, // the crossbar, mostly to the right of the stem
]

function crc32(buf) {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const isInGlyph = (x, y, size) =>
  GLYPH.some(
    (r) =>
      x >= r.x * size && x < (r.x + r.w) * size && y >= r.y * size && y < (r.y + r.h) * size,
  )

function png(size) {
  // One filter byte per row, then three bytes per pixel: the raw truecolour layout.
  const raw = Buffer.alloc((size * 3 + 1) * size)
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = isInGlyph(x, y, size) ? FOREGROUND : BACKGROUND
      raw[o++] = r
      raw[o++] = g
      raw[o++] = b
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const size of [192, 512]) {
  const path = join(PUBLIC_DIR, `icon-${size}.png`)
  writeFileSync(path, png(size))
  console.log(`wrote ${path}`)
}
