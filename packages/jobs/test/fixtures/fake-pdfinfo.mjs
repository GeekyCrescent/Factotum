#!/usr/bin/env node
/**
 * A stand-in for Poppler's `pdfinfo <pdf>` (design D5 step 7), so a test counts pages without Poppler.
 * LAUNCHED BY PATH, never imported: it stays out of `tsc`.
 *
 * THE PAGES come from the "PDF" itself: `fake-chromium.mjs` writes `%PDF-fake pages=N`; any other file
 * counts as 1 page. The output has the shape of the real one (Poppler 26, measured on a 1-page A4 PDF).
 *
 * WHAT IT DOES is chosen by `fake-poppler.mode` in the PDF's folder (no file = `ok`):
 *   ok         prints the info
 *   no-pages   prints the info without its `Pages:` line
 *   fail       what the real one does with a file it cannot open: one line on stderr, exit 1
 *   hang       never answers, and starts a grandchild that hangs too (the group must die whole)
 *   stubborn   never answers and ignores SIGTERM (writes `fake-poppler.ready` once it does): only SIGKILL ends it
 *   escape     never answers, and starts a grandchild IN ANOTHER GROUP that holds its stdout open: killing
 *              the group never brings `close` (the test kills the grandchild itself)
 * Every call appends its pid to `fake-poppler.calls` in that folder; `hang` and `escape` append the grandchild's.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const pdf = process.argv[process.argv.length - 1]
const dir = dirname(pdf)
appendFileSync(join(dir, 'fake-poppler.calls'), `${process.pid}\n`)
const modeFile = join(dir, 'fake-poppler.mode')
const mode = existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : 'ok'

if (mode === 'stubborn') {
  process.on('SIGTERM', () => undefined)
  writeFileSync(join(dir, 'fake-poppler.ready'), '')
  setTimeout(() => process.exit(0), 60_000)
} else if (mode === 'escape') {
  const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true })
  grandchild.unref()
  appendFileSync(join(dir, 'fake-poppler.calls'), `${grandchild.pid}\n`)
  setTimeout(() => process.exit(0), 60_000)
} else if (mode === 'hang') {
  const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
  appendFileSync(join(dir, 'fake-poppler.calls'), `${grandchild.pid}\n`)
  setTimeout(() => process.exit(0), 60_000)
} else if (mode === 'fail' || !existsSync(pdf)) {
  process.stderr.write(`I/O Error: Couldn't open file '${pdf}': No such file or directory.\n`)
  process.exit(1)
} else {
  const pages = /pages=(\d+)/.exec(readFileSync(pdf, 'latin1'))?.[1] ?? '1'
  const lines = [
    'Producer:        Skia/PDF m152',
    'Creator:         Chromium',
    'CreationDate:    Fri Nov 13 17:37:00 2026 AEDT',
    'ModDate:         Fri Nov 13 17:37:00 2026 AEDT',
    'Custom Metadata: no',
    'Metadata Stream: no',
    'Tagged:          yes',
    'UserProperties:  no',
    'Suspects:        no',
    'Form:            none',
    'JavaScript:      no',
    ...(mode === 'no-pages' ? [] : [`Pages:           ${pages}`]),
    'Encrypted:       no',
    'Page size:       594.96 x 841.92 pts (A4)',
    'Page rot:        0',
    'File size:       45210 bytes',
    'Optimized:       no',
    'PDF version:     1.4',
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}
