/**
 * Serving the client from the same process as the API.
 *
 * One address is the whole point: the QR carries a single URL, and everything —
 * the page, the module screens, the API — is behind it. A separately deployed client
 * would mean two addresses to keep straight on a phone.
 */

import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { StaticSite } from './server.ts'

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * What Vite emits with a content hash in the name. Only these can be cached for good: the hash
 * changes when the bytes do. Everything else — `index.html`, `sw.js`, the manifest, the icons, and
 * the SPA fallback for any route — must be fetched again, or the PWA cannot update.
 */
const HASHED_DIR = 'assets'

export function createStaticSite(root: string): StaticSite {
  const base = resolve(root)

  return {
    serve: async (path: string) => {
      // The client is a single page: anything that is not a file it owns falls back
      // to index.html so that /m/<id> survives a reload.
      const candidates = path === '/' ? ['index.html'] : [path.slice(1), 'index.html']

      for (const candidate of candidates) {
        const full = resolve(join(base, normalize(candidate)))
        // Defence in depth: the request path is already normalised by the server, but
        // a static file server that can be talked out of its root is the classic way
        // to read /etc/passwd, and the check costs one comparison.
        if (!full.startsWith(base + sep) && full !== base) continue

        try {
          const body = await readFile(full)
          const immutable = full.startsWith(join(base, HASHED_DIR) + sep)
          return { body, type: TYPES[extname(full)] ?? 'application/octet-stream', immutable }
        } catch {
          continue
        }
      }

      return undefined
    },
  }
}
