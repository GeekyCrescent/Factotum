/**
 * The two PWA icons, generated rather than committed as binaries nobody can edit.
 *
 * `node apps/web/scripts/make-icons.mjs` rewrites `public/icon-192.png` and
 * `public/icon-512.png` with the CHOSEN glyph. It runs by hand, not in the build: the icons change
 * about never, and a build step that rewrites tracked files makes every `git status` lie.
 *
 * `node apps/web/scripts/make-icons.mjs --preview <dir>` writes every candidate to `<dir>`, whole
 * and cropped to the circle Android may cut it to, and touches nothing in `public/` (spec
 * 2026-09-18, design D11: the owner picks one on the phone).
 *
 * A minimal PNG encoder, because a picture of a letter is not worth a dependency, and `zlib` is
 * already in Node.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

// Copies of tokens.css, dark block, in sRGB: a PNG cannot read a custom property. `--bg` is the
// manifest's colour, so the splash and the icon meet without a seam.
const BACKGROUND = [13, 14, 17] // --bg
const FOREGROUND = [239, 240, 242] // --text
const ACCENT = [71, 103, 211] // --accent: the one indigo detail the direction allows

/** Which candidate `public/` gets: the owner picked the prompt on 2026-09-19. */
const CHOSEN = 'prompt'

/** Samples per side of each pixel: 4×4 is enough for edges that do not look stepped at 192 px. */
const SAMPLES = 4

/**
 * THE CANDIDATES, in fractions of the icon's side. Each is a list of shapes, drawn in order, and
 * every one sits inside the centred circle of 80% diameter: that is what `purpose: "maskable"`
 * needs, because Android may crop the icon to a circle and anything outside it is cut off.
 */
const rect = (x, y, w, h, color = FOREGROUND) => ({ color, hit: (u, v) => u >= x && u < x + w && v >= y && v < y + h })
const disc = (cx, cy, r, color = FOREGROUND) => ({ color, hit: (u, v) => (u - cx) ** 2 + (v - cy) ** 2 <= r * r })
const ring = (cx, cy, r, t, color = FOREGROUND) => ({
  color,
  hit: (u, v) => {
    const d = Math.hypot(u - cx, v - cy)
    return d <= r && d >= r - t
  },
})
/** A thick segment from (x1, y1) to (x2, y2), with round ends. */
const stroke = (x1, y1, x2, y2, t, color = FOREGROUND) => ({
  color,
  hit: (u, v) => {
    const dx = x2 - x1
    const dy = y2 - y1
    const k = Math.max(0, Math.min(1, ((u - x1) * dx + (v - y1) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(u - (x1 + k * dx), v - (y1 + k * dy)) <= t / 2
  },
})

const CANDIDATES = {
  // A lowercase f, as it was, with an indigo cursor where the next letter would go.
  f: [rect(0.4, 0.28, 0.1, 0.44), rect(0.4, 0.28, 0.22, 0.09), rect(0.32, 0.45, 0.22, 0.08), rect(0.56, 0.62, 0.1, 0.1, ACCENT)],
  // A prompt: the chevron in graphite, the cursor in indigo.
  prompt: [stroke(0.31, 0.35, 0.46, 0.5, 0.085), stroke(0.46, 0.5, 0.31, 0.65, 0.085), rect(0.52, 0.6, 0.2, 0.075, ACCENT)],
  // A ring, the session, with its one point of attention in indigo.
  ring: [ring(0.5, 0.5, 0.25, 0.075), disc(0.5, 0.5, 0.075, ACCENT)],
}

function colorAt(shapes, u, v) {
  let color = BACKGROUND
  for (const shape of shapes) if (shape.hit(u, v)) color = shape.color
  return color
}

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

/** `cropped`: paint outside the 80% circle white, to see what a round mask leaves. */
function png(shapes, size, cropped = false) {
  // One filter byte per row, then three bytes per pixel: the raw truecolour layout.
  const raw = Buffer.alloc((size * 3 + 1) * size)
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0]
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const u = (x + (sx + 0.5) / SAMPLES) / size
          const v = (y + (sy + 0.5) / SAMPLES) / size
          const outside = cropped && Math.hypot(u - 0.5, v - 0.5) > 0.4
          const c = outside ? [255, 255, 255] : colorAt(shapes, u, v)
          sum[0] += c[0]
          sum[1] += c[1]
          sum[2] += c[2]
        }
      }
      for (const channel of sum) raw[o++] = Math.round(channel / (SAMPLES * SAMPLES))
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

const previewAt = process.argv.indexOf('--preview')
if (previewAt >= 0) {
  const dir = resolve(process.argv[previewAt + 1] ?? '.')
  mkdirSync(dir, { recursive: true })
  for (const [name, shapes] of Object.entries(CANDIDATES)) {
    writeFileSync(join(dir, `icon-${name}.png`), png(shapes, 512))
    writeFileSync(join(dir, `icon-${name}-circle.png`), png(shapes, 512, true))
    console.log(`wrote ${join(dir, `icon-${name}.png`)} and its circle`)
  }
} else {
  for (const size of [192, 512]) {
    const path = join(PUBLIC_DIR, `icon-${size}.png`)
    writeFileSync(path, png(CANDIDATES[CHOSEN], size))
    console.log(`wrote ${path}`)
  }
}
