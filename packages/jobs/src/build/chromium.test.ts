import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { eventually, manualTimers, realTimers, tempBase } from '../test-support.ts'
import { chromiumArgs, CHROMIUM_TIMEOUT_MS, printPdf, type ChromiumRun } from './chromium.ts'
import { countPages } from './pdf.ts'

const FIXTURES = new URL('../../test/fixtures/', import.meta.url)
const FAKE_CHROMIUM = fileURLToPath(new URL('fake-chromium.mjs', FIXTURES))
const FAKE_PDFINFO = fileURLToPath(new URL('fake-pdfinfo.mjs', FIXTURES))
chmodSync(FAKE_CHROMIUM, 0o755)
chmodSync(FAKE_PDFINFO, 0o755)

const HTML = '<!doctype html><p>CV</p>'

const run = (stateDir: string, over: Partial<ChromiumRun> = {}): ChromiumRun => ({ bin: FAKE_CHROMIUM, stateDir, timers: realTimers, ...over })

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const callsIn = (stateDir: string): number[] => {
  const file = join(stateDir, 'chromium', 'fake-chromium.calls')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(Number) : []
}

function modes(stateDir: string, ...lines: string[]): void {
  mkdirSync(join(stateDir, 'chromium'), { recursive: true })
  writeFileSync(join(stateDir, 'chromium', 'fake-chromium.modes'), `${lines.join('\n')}\n`)
}

test('the command is D5’s, exactly: headless, no GPU, no header or footer, its own profile, no --no-sandbox', () => {
  assert.deepEqual(chromiumArgs('/state', '/state/render/a1/cv.html', '/state/render/a1/cv.pdf'), [
    '--headless',
    '--disable-gpu',
    '--no-pdf-header-footer',
    '--user-data-dir=/state/chromium',
    '--print-to-pdf=/state/render/a1/cv.pdf',
    'file:///state/render/a1/cv.html',
  ])
})

test('a path with a space or a # is a proper file URL', () => {
  const args = chromiumArgs('/s', '/s/render/a b#1/cv.html', '/s/render/a b#1/cv.pdf')
  assert.equal(args.at(-1), pathToFileURL('/s/render/a b#1/cv.html').href)
})

test('printPdf writes the HTML in <stateDir>/render/<id>/, prints it, and answers the PDF’s path', async () => {
  using base = tempBase()
  const result = await printPdf(run(base.dir), 'app-1-v2', HTML)
  const dir = join(base.dir, 'render', 'app-1-v2')
  assert.deepEqual(result, { ok: true, value: join(dir, 'cv.pdf') })
  assert.equal(readFileSync(join(dir, 'cv.html'), 'utf8'), HTML)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(readFileSync(join(base.dir, 'chromium', 'fake-chromium.html.1'), 'utf8'), HTML, 'chromium read our HTML')
  const args = readFileSync(join(base.dir, 'chromium', 'fake-chromium.args.1'), 'utf8').split('\0')
  assert.deepEqual(args, chromiumArgs(base.dir, join(dir, 'cv.html'), join(dir, 'cv.pdf')))
})

test('a 2-page print is counted 2 by pdfinfo (the fakes agree with each other)', async () => {
  using base = tempBase()
  modes(base.dir, 'pages=2', 'pages=1')
  const first = await printPdf(run(base.dir), 'a1', HTML)
  assert.equal(first.ok, true)
  const poppler = { poppler: { pdfinfo: FAKE_PDFINFO, pdftoppm: FAKE_PDFINFO }, timers: realTimers }
  assert.deepEqual(await countPages(poppler, first.ok ? first.value : ''), { ok: true, value: 2 })
  const second = await printPdf(run(base.dir), 'a1', HTML)
  assert.deepEqual(await countPages(poppler, second.ok ? second.value : ''), { ok: true, value: 1 })
})

test('a stale PDF of an earlier print never passes for this one', async () => {
  using base = tempBase()
  modes(base.dir, 'pages=1', 'no-pdf')
  assert.equal((await printPdf(run(base.dir), 'a1', HTML)).ok, true)
  assert.deepEqual(await printPdf(run(base.dir), 'a1', HTML), { ok: false, error: { code: 'module-error', reason: 'chromium wrote no PDF' } })
})

test('a binary that is not there is a Result with its reason, never a throw', async () => {
  using base = tempBase()
  const result = await printPdf(run(base.dir, { bin: join(base.dir, 'no-chromium') }), 'a1', HTML)
  assert.deepEqual(result, { ok: false, error: { code: 'module-error', reason: 'chromium could not start (ENOENT)' } })
})

test('a non-zero exit is a failure with its code, and nothing of stderr', async () => {
  using base = tempBase()
  modes(base.dir, 'fail')
  assert.deepEqual(await printPdf(run(base.dir), 'a1', HTML), { ok: false, error: { code: 'module-error', reason: 'chromium exited with code 1' } })
})

test('a hung chromium is killed at 30 s on the injected timers, and its whole group dies', async () => {
  using base = tempBase()
  modes(base.dir, 'hang')
  const manual = manualTimers()
  const pending = printPdf(run(base.dir, { timers: manual.timers }), 'a1', HTML)
  await eventually(() => callsIn(base.dir).length === 2, 'chromium and its grandchild started')
  assert.deepEqual(manual.pending(), [CHROMIUM_TIMEOUT_MS])
  manual.fire(CHROMIUM_TIMEOUT_MS)
  assert.deepEqual(await pending, { ok: false, error: { code: 'module-error', reason: 'chromium gave no answer within 30 s' } })
  for (const pid of callsIn(base.dir)) await eventually(() => !alive(pid), `process ${pid} gone`)
})

test('an aborted signal answers stopped and never spawns', async () => {
  using base = tempBase()
  const stop = new AbortController()
  stop.abort()
  assert.deepEqual(await printPdf(run(base.dir, { signal: stop.signal }), 'a1', HTML), { ok: false, error: { code: 'module-error', reason: 'stopped' } })
  assert.deepEqual(callsIn(base.dir), [])
})

test('a render id that could leave render/ is refused before anything is written', async () => {
  using base = tempBase()
  for (const id of ['..', '../x', 'a/b', '', '.hidden']) {
    const result = await printPdf(run(base.dir), id, HTML)
    assert.equal(result.ok, false, id)
    assert.equal(!result.ok && result.error.code, 'invalid')
  }
  assert.equal(existsSync(join(base.dir, 'render')), false)
})

test('a render folder that cannot be made is a Result with its reason', async () => {
  using base = tempBase()
  writeFileSync(join(base.dir, 'render'), 'a file where the folder goes')
  const result = await printPdf(run(base.dir), 'a1', HTML)
  assert.deepEqual(result, { ok: false, error: { code: 'module-error', reason: 'the render folder could not be written (ENOTDIR)' } })
})
