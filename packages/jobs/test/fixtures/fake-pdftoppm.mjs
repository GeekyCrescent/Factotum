#!/usr/bin/env node
/**
 * A stand-in for `pdftoppm -png -r 110 -f 1 -l 1 -singlefile <pdf> <prefix>` (design D5 step 7): writes
 * `<prefix>.png`, a real 1×1 PNG. LAUNCHED BY PATH, never imported: it stays out of `tsc`.
 *
 * WHAT IT DOES is chosen by `fake-poppler.mode` in the PDF's folder (no file = `ok`):
 *   ok         writes the PNG
 *   no-output  exits 0 without writing anything
 *   fail       one line on stderr, exit 1
 *   hang       never answers
 * Every call appends its pid to `fake-poppler.calls` in that folder, and its arguments to
 * `fake-pdftoppm.args` (one call per line, NUL-separated).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const [pdf, prefix] = args.slice(-2)
const dir = dirname(pdf)
appendFileSync(join(dir, 'fake-poppler.calls'), `${process.pid}\n`)
appendFileSync(join(dir, 'fake-pdftoppm.args'), `${args.join('\0')}\n`)
const modeFile = join(dir, 'fake-poppler.mode')
const mode = existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : 'ok'

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

if (mode === 'hang') setTimeout(() => process.exit(0), 60_000)
else if (mode === 'fail' || !existsSync(pdf)) {
  process.stderr.write(`I/O Error: Couldn't open file '${pdf}': No such file or directory.\n`)
  process.exit(1)
} else if (mode !== 'no-output') writeFileSync(`${prefix}.png`, Buffer.from(PNG_1X1, 'base64'))
