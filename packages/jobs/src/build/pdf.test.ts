import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eventually, manualTimers, realTimers, tempBase } from '../test-support.ts'
import { countPages, pagesOf, POPPLER_TIMEOUT_MS, renderPreview, type PopplerRun } from './pdf.ts'
import { KILL_GRACE_MS } from './process.ts'

const FIXTURES = new URL('../../test/fixtures/', import.meta.url)
const FAKE_PDFINFO = fileURLToPath(new URL('fake-pdfinfo.mjs', FIXTURES))
const FAKE_PDFTOPPM = fileURLToPath(new URL('fake-pdftoppm.mjs', FIXTURES))
chmodSync(FAKE_PDFINFO, 0o755)
chmodSync(FAKE_PDFTOPPM, 0o755)

const POPPLER = { pdfinfo: FAKE_PDFINFO, pdftoppm: FAKE_PDFTOPPM }

/**
 * `pdfinfo` as Poppler 26.04 printed it on this Mac for a 1-page A4 PDF (13 Nov 2026), Producer and
 * Creator as Chromium writes them: the same shape A2 measured on `omarchy` (Poppler 26.08).
 */
const ONE_PAGE = `Producer:        Skia/PDF m152
Creator:         Chromium
CreationDate:    Fri Nov 13 17:37:00 2026 AEDT
ModDate:         Fri Nov 13 17:37:00 2026 AEDT
Custom Metadata: no
Metadata Stream: no
Tagged:          yes
UserProperties:  no
Suspects:        no
Form:            none
JavaScript:      no
Pages:           1
Encrypted:       no
Page size:       594.96 x 841.92 pts (A4)
Page rot:        0
File size:       45210 bytes
Optimized:       no
PDF version:     1.4
`

const run = (over: Partial<PopplerRun> = {}): PopplerRun => ({ poppler: POPPLER, timers: realTimers, ...over })

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const callsIn = (dir: string): number[] => {
  const file = join(dir, 'fake-poppler.calls')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(Number) : []
}

test('pagesOf reads the Pages: line of real pdfinfo output', () => {
  assert.deepEqual(pagesOf(ONE_PAGE), { ok: true, value: 1 })
  assert.deepEqual(pagesOf(ONE_PAGE.replace('Pages:           1', 'Pages:           4')), { ok: true, value: 4 })
})

test('pagesOf: output without a Pages: line, or with zero pages, is a Result with its reason', () => {
  const none = pagesOf(ONE_PAGE.replace('Pages:           1\n', ''))
  assert.deepEqual(none, { ok: false, error: { code: 'module-error', reason: 'pdfinfo printed no Pages: line' } })
  assert.equal(pagesOf('Pages:           0\n').ok, false)
  assert.equal(pagesOf('').ok, false)
})

test('countPages runs pdfinfo on the PDF and reads its pages', async () => {
  using base = tempBase()
  const pdf = join(base.dir, 'cv.pdf')
  writeFileSync(pdf, '%PDF-fake pages=2\n')
  assert.deepEqual(await countPages(run(), pdf), { ok: true, value: 2 })
})

test('pdfinfo output without Pages: is a failure with its reason', async () => {
  using base = tempBase()
  const pdf = join(base.dir, 'cv.pdf')
  writeFileSync(pdf, '%PDF-fake pages=1\n')
  writeFileSync(join(base.dir, 'fake-poppler.mode'), 'no-pages')
  assert.deepEqual(await countPages(run(), pdf), { ok: false, error: { code: 'module-error', reason: 'pdfinfo printed no Pages: line' } })
})

test('a binary that is not there is a Result with its reason, never a throw', async () => {
  using base = tempBase()
  const pdf = join(base.dir, 'cv.pdf')
  writeFileSync(pdf, '%PDF-fake\n')
  const missing = { pdfinfo: join(base.dir, 'no-pdfinfo'), pdftoppm: join(base.dir, 'no-pdftoppm') }
  assert.deepEqual(await countPages(run({ poppler: missing }), pdf), { ok: false, error: { code: 'module-error', reason: 'pdfinfo could not start (ENOENT)' } })
  assert.deepEqual(await renderPreview(run({ poppler: missing }), pdf, base.dir), {
    ok: false,
    error: { code: 'module-error', reason: 'pdftoppm could not start (ENOENT)' },
  })
})

test('a non-zero exit is a failure with its code, and nothing of stderr (which names the path)', async () => {
  using base = tempBase()
  const pdf = join(base.dir, 'cv.pdf')
  writeFileSync(pdf, '%PDF-fake\n')
  writeFileSync(join(base.dir, 'fake-poppler.mode'), 'fail')
  assert.deepEqual(await countPages(run(), pdf), { ok: false, error: { code: 'module-error', reason: 'pdfinfo exited with code 1' } })
})

test('a hung pdfinfo is killed at 15 s on the injected timers, and its whole group dies', async () => {
  using base = tempBase()
  const pdf = join(base.dir, 'cv.pdf')
  writeFileSync(pdf, '%PDF-fake\n')
  writeFileSync(join(base.dir, 'fake-poppler.mode'), 'hang')
  const manual = manualTimers()
  const pending = countPages(run({ timers: manual.timers }), pdf)
  await eventually(() => callsIn(base.dir).length === 2, 'pdfinfo and its grandchild started')
  assert.deepEqual(manual.pending(), [POPPLER_TIMEOUT_MS])
  manual.fire(POPPLER_TIMEOUT_MS)
  assert.deepEqual(await pending, { ok: false, error: { code: 'module-error', reason: 'pdfinfo gave no answer within 15 s' } })
  for (const pid of callsIn(base.dir)) await eventually(() => !alive(pid), `process ${pid} gone`)
  assert.deepEqual(manual.pending(), [], 'the SIGKILL grace is disposed once the run settled')
})

test('a group that ignores SIGTERM gets SIGKILL after the grace, and the run still settles', async () => {
  using base = tempBase()
  const pdf = join(base.dir, 'cv.pdf')
  writeFileSync(pdf, '%PDF-fake\n')
  writeFileSync(join(base.dir, 'fake-poppler.mode'), 'stubborn')
  const manual = manualTimers()
  const pending = countPages(run({ timers: manual.timers }), pdf)
  await eventually(() => callsIn(base.dir).length === 1, 'pdfinfo started')
  await eventually(() => existsSync(join(base.dir, 'fake-poppler.ready')), 'SIGTERM ignored')
  manual.fire(POPPLER_TIMEOUT_MS)
  assert.deepEqual(manual.pending(), [KILL_GRACE_MS])
  const [pid] = callsIn(base.dir)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(alive(pid!), true, 'SIGTERM alone did not end it')
  manual.fire(KILL_GRACE_MS)
  assert.deepEqual(await pending, { ok: false, error: { code: 'module-error', reason: 'pdfinfo gave no answer within 15 s' } })
  await eventually(() => !alive(pid!), 'the stubborn pdfinfo is gone')
})

test('the signal aborted mid-run kills the group and answers stopped; already aborted never spawns', async () => {
  using base = tempBase()
  const pdf = join(base.dir, 'cv.pdf')
  writeFileSync(pdf, '%PDF-fake\n')
  writeFileSync(join(base.dir, 'fake-poppler.mode'), 'hang')
  const stop = new AbortController()
  const pending = countPages(run({ signal: stop.signal }), pdf)
  await eventually(() => callsIn(base.dir).length === 2, 'pdfinfo started')
  stop.abort()
  assert.deepEqual(await pending, { ok: false, error: { code: 'module-error', reason: 'stopped' } })
  for (const pid of callsIn(base.dir)) await eventually(() => !alive(pid), `process ${pid} gone`)

  const before = callsIn(base.dir).length
  assert.deepEqual(await countPages(run({ signal: stop.signal }), pdf), { ok: false, error: { code: 'module-error', reason: 'stopped' } })
  assert.equal(callsIn(base.dir).length, before)
})

test('renderPreview: pdftoppm -png -r 110 page 1 only, single file, to <dir>/preview.png', async () => {
  using base = tempBase()
  const pdf = join(base.dir, 'cv.pdf')
  writeFileSync(pdf, '%PDF-fake pages=2\n')
  const out = join(base.dir, 'v1')
  const result = await renderPreview(run(), pdf, out)
  assert.deepEqual(result, { ok: true, value: join(out, 'preview.png') })
  assert.equal(readFileSync(join(out, 'preview.png')).subarray(1, 4).toString('latin1'), 'PNG')
  const args = readFileSync(join(base.dir, 'fake-pdftoppm.args'), 'utf8').trim().split('\0')
  assert.deepEqual(args, ['-png', '-r', '110', '-f', '1', '-l', '1', '-singlefile', pdf, join(out, 'preview')])
})

test('a pdftoppm that exits 0 without writing the PNG is a failure, not a missing preview later', async () => {
  using base = tempBase()
  const pdf = join(base.dir, 'cv.pdf')
  writeFileSync(pdf, '%PDF-fake\n')
  writeFileSync(join(base.dir, 'fake-poppler.mode'), 'no-output')
  assert.deepEqual(await renderPreview(run(), pdf, base.dir), {
    ok: false,
    error: { code: 'module-error', reason: 'pdftoppm wrote no preview.png' },
  })
})

test('a hung pdftoppm is killed at 15 s too', async () => {
  using base = tempBase()
  const pdf = join(base.dir, 'cv.pdf')
  writeFileSync(pdf, '%PDF-fake\n')
  writeFileSync(join(base.dir, 'fake-poppler.mode'), 'hang')
  const manual = manualTimers()
  const pending = renderPreview(run({ timers: manual.timers }), pdf, base.dir)
  await eventually(() => callsIn(base.dir).length === 1, 'pdftoppm started')
  manual.fire(POPPLER_TIMEOUT_MS)
  assert.deepEqual(await pending, { ok: false, error: { code: 'module-error', reason: 'pdftoppm gave no answer within 15 s' } })
  const [pid] = callsIn(base.dir)
  await eventually(() => !alive(pid!), 'pdftoppm gone')
})
