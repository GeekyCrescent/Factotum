import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { capturedLog, realTimers, tempBase } from '../test-support.ts'
import { clearRender, keepPrint, printCv, type PrintDeps, type Printed } from './print.ts'
import { DOC, PROFILE } from './test-cv.ts'
import { FAKE_CHROMIUM, FAKE_PDFINFO, FAKE_PDFTOPPM, FONT } from './test-builder.ts'

const signal = new AbortController().signal
const deps = (stateDir: string, over: Partial<PrintDeps> = {}): PrintDeps => ({
  stateDir,
  timers: realTimers,
  log: capturedLog().log,
  font: FONT,
  chromium: FAKE_CHROMIUM,
  poppler: { pdfinfo: FAKE_PDFINFO, pdftoppm: FAKE_PDFTOPPM },
  ...over,
})

function aPrint(stateDir: string): Printed {
  const pdf = join(stateDir, 'render', 'r1', 'cv.pdf')
  mkdirSync(join(stateDir, 'render', 'r1'), { recursive: true })
  writeFileSync(pdf, '%PDF-fake pages=1\n')
  return { pdf, pages: 1, contactHash: 'hash' }
}

test('a print whose pages cannot be counted is a failed run with the reason', async () => {
  using base = tempBase()
  const printed = await printCv(deps(base.dir, { poppler: { pdfinfo: join(base.dir, 'no-pdfinfo'), pdftoppm: FAKE_PDFTOPPM } }), 'r1', DOC, PROFILE, signal)
  assert.equal(printed.ok, false)
  assert.match(printed.ok ? '' : printed.reason, /pdfinfo/)
})

test('an application id that is not a path segment never reaches the disk', async () => {
  using base = tempBase()
  const kept = await keepPrint(deps(base.dir), '../escape', 2, aPrint(base.dir), signal)
  assert.deepEqual(kept, { ok: false, kind: 'failed', reason: 'an application id is letters, digits, dashes and underscores' })
  assert.equal(existsSync(join(base.dir, 'escape')), false)
})

test('an artifacts folder that cannot be made, a print that is gone, a preview that fails: each a failed run', async () => {
  using base = tempBase()
  writeFileSync(join(base.dir, 'artifacts'), 'a file where the folder goes')
  const noFolder = await keepPrint(deps(base.dir), 'app-1', 2, aPrint(base.dir), signal)
  assert.match(noFolder.ok ? '' : noFolder.reason, /the artifacts folder could not be made/)

  using other = tempBase()
  const gone = await keepPrint(deps(other.dir), 'app-1', 2, { pdf: join(other.dir, 'nothing.pdf'), pages: 1, contactHash: 'h' }, signal)
  assert.match(gone.ok ? '' : gone.reason, /the PDF could not be moved/)

  const noPreview = await keepPrint(deps(other.dir, { poppler: { pdfinfo: FAKE_PDFINFO, pdftoppm: join(other.dir, 'no-pdftoppm') } }), 'app-1', 5, aPrint(other.dir), signal)
  assert.match(noPreview.ok ? '' : noPreview.reason, /pdftoppm/)
})

test('a version folder that cannot be made for another reason than «taken» is said', async () => {
  using base = tempBase()
  mkdirSync(join(base.dir, 'artifacts', 'app-1'), { recursive: true })
  writeFileSync(join(base.dir, 'artifacts', 'app-1', 'v2'), '')
  const kept = await keepPrint(deps(base.dir), 'app-1', 2, aPrint(base.dir), signal)
  assert.equal(kept.ok, true, 'a file named v2 is taken too: v3')

  using locked = tempBase()
  mkdirSync(join(locked.dir, 'artifacts', 'app-1'), { recursive: true })
  chmodSync(join(locked.dir, 'artifacts', 'app-1'), 0o500)
  const refused = await keepPrint(deps(locked.dir), 'app-1', 2, aPrint(locked.dir), signal)
  assert.match(refused.ok ? '' : refused.reason, /the version folder could not be made \(EACCES\)/)
})

test('clearing a render folder ignores an id that is not ours and removes one that is', () => {
  using base = tempBase()
  aPrint(base.dir)
  clearRender(deps(base.dir), '..')
  assert.ok(existsSync(join(base.dir, 'render', 'r1')))
  clearRender(deps(base.dir), 'r1')
  assert.equal(existsSync(join(base.dir, 'render', 'r1')), false)
})
