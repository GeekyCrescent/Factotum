import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The installable-app minimum, guarded by what the phone actually measured.
 *
 * Every assertion here corresponds to a measurement from block A7 of the TLS spec,
 * taken on Chrome 153 / Android over `tailscale serve`. They are cheap to keep and
 * they fail loudly: an empty `icons` array is not a build error, not a type error and
 * not a runtime error — it is a phone that quietly never offers to install.
 */

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..')
const readPublic = (name: string) => readFile(join(WEB, 'public', name))

/**
 * `.webmanifest`, NOT `.json`, and the extension is the whole point.
 *
 * The daemon's static server picks the content type from the extension
 * (`kernel/src/http/static.ts`), so `manifest.json` goes out as `application/json`.
 * MEASURED on Android: with that type Chrome parses the manifest, registers the
 * service worker, reports a secure context — and then offers a plain HOME SCREEN
 * SHORTCUT instead of installing, which opens in a tab with the address bar. The
 * throwaway A7 probe served `application/manifest+json` and was offered as an app.
 * Same manifest, same icons, same worker: the type was the difference.
 */
const MANIFEST = 'manifest.webmanifest'

interface Manifest {
  readonly icons: readonly { src: string; sizes: string; type: string; purpose?: string }[]
  readonly display: string
  readonly start_url: string
}

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readPublic(MANIFEST).then((b) => b.toString('utf8'))) as Manifest
}

test('the manifest declares both icons — with none, Chrome never offers to install', async () => {
  // MEASURED, and the only variant that failed: with `icons: []` the install prompt
  // did not fire on Android, service worker or not.
  const { icons } = await manifest()
  assert.deepEqual(
    icons.map((i) => `${i.sizes} ${i.purpose ?? 'any'}`),
    ['192x192 any', '512x512 maskable'],
  )
})

test('every icon the manifest names EXISTS, and is a PNG of the size it claims', async () => {
  // A manifest pointing at a 404 is the same failure as no icons, and nothing else in
  // the build would notice: `public/` is copied verbatim.
  for (const icon of (await manifest()).icons) {
    const bytes = await readPublic(icon.src.replace(/^\//, ''))
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // The IHDR width and height, at a fixed offset in every PNG.
    const side = Number(icon.sizes.split('x')[0])
    assert.equal(bytes.readUInt32BE(16), side, `${icon.src} width`)
    assert.equal(bytes.readUInt32BE(20), side, `${icon.src} height`)
  }
})

test('the manifest asks for standalone, which is what "installed" means here', async () => {
  const m = await manifest()
  assert.equal(m.display, 'standalone')
  assert.equal(m.start_url, '/')
})

test('the service worker has NO fetch handler, because the phone does not require one', async () => {
  // The measurement that kept this file small: a worker with only `install` and
  // `activate` was offered for install on Chrome 153. A `fetch` handler would put the
  // worker in the path of every request while doing nothing.
  const sw = (await readPublic('sw.js')).toString('utf8')
  assert.doesNotMatch(sw, /addEventListener\(\s*['"]fetch['"]/)
  assert.match(sw, /addEventListener\(\s*['"]install['"]/)
  assert.match(sw, /addEventListener\(\s*['"]activate['"]/)
})

test('index.html links THE FILE THAT EXISTS, with the extension that types it', async () => {
  // Two halves of one failure. The href must resolve — a 404 manifest is no manifest —
  // and it must end in `.webmanifest`, because that extension is what makes the daemon
  // send `application/manifest+json`. With `application/json` Android downgrades the
  // install to a home-screen shortcut, silently: no console error, no 404, no warning.
  const html = await readFile(join(WEB, 'index.html'), 'utf8')
  const href = /<link rel="manifest" href="([^"]+)"/.exec(html)?.[1]
  assert.equal(href, `/${MANIFEST}`)
  await readPublic(MANIFEST)
})

test('registration is guarded by isSecureContext, so plain HTTP does not throw', async () => {
  // Over http (`pnpm dev`, or the bind with serve down) `register` rejects. Without
  // the guard that is an unhandled rejection on every single load.
  const main = await readFile(join(WEB, 'src', 'main.tsx'), 'utf8')
  assert.match(main, /if \(isSecureContext && 'serviceWorker' in navigator\)/)
  assert.match(main, /register\('\/sw\.js'\)[\s\S]*\.catch\(/)
})
