import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

/**
 * Runs from `pnpm --filter @factotum/web test:build`, NOT from `test`: it builds the client, and
 * that takes seconds.
 *
 * WHY IT EXISTS (spec 2026-09-18, criterion 5): Vite does not fail the build when a url() in the
 * CSS points at a file that is not there — it warns and leaves it for the runtime — and at runtime
 * the daemon's SPA fallback answers any missing file with index.html and a 200. A broken font
 * would ship silently as the system font. This builds and looks.
 *
 * TO A TEMPORARY DIRECTORY, NEVER TO dist/: the production daemon serves this checkout's dist/ on
 * every request (spec §0.16), and a test that rewrote it would change what the phone gets.
 */

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')

test('every font the built CSS points at exists in the build (criterion 5)', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'factotum-build-check-'))
  try {
    await build({ root: APP, logLevel: 'error', build: { outDir, emptyOutDir: true } })

    const assets = join(outDir, 'assets')
    const css = (await readdir(assets)).filter((name) => name.endsWith('.css'))
    assert.ok(css.length > 0, 'the build produced no CSS')

    const fonts: string[] = []
    for (const file of css) {
      const text = await readFile(join(assets, file), 'utf8')
      for (const m of text.matchAll(/url\(\s*['"]?([^'")]+\.woff2)['"]?\s*\)/g)) fonts.push(m[1] ?? '')
    }
    assert.ok(fonts.length >= 2, `expected the two woff2 faces, found ${fonts.length}`)

    for (const url of fonts) {
      const path = join(outDir, url.replace(/^\//, ''))
      await assert.doesNotReject(stat(path), `the CSS points at ${url}, which the build does not contain`)
    }
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})
