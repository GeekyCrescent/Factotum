#!/usr/bin/env node
/**
 * A stand-in for `chromium --headless --disable-gpu --no-pdf-header-footer --user-data-dir=<dir>
 * --print-to-pdf=<pdf> file://<html>` (design D5 step 6). LAUNCHED BY PATH, never imported.
 *
 * ITS STATE LIVES IN `--user-data-dir` (`<stateDir>/chromium`), the one folder every print shares, so
 * a test can script a sequence across prints (2 pages, then 1):
 * - `fake-chromium.modes`: one mode per line, call N takes line N and the last line repeats; no file
 *   means `pages=1`;
 * - `fake-chromium.calls`: every call appends its pid (`hang` appends its grandchild's too);
 * - `fake-chromium.args.<N>` and `fake-chromium.html.<N>`: the arguments (NUL-separated) and the HTML
 *   it was given;
 * - `fake-chromium.timeline`: `start <pid>` when it begins and `end <pid>` when it writes its PDF, so a
 *   test can see whether two prints overlapped on the same profile.
 *
 *   pages=N    writes a "PDF" `%PDF-fake pages=N` that fake-pdfinfo counts
 *   slow       like pages=1, after 300 ms
 *   no-pdf     exits 0 without writing the PDF
 *   fail       one line on stderr, exit 1
 *   hang       never answers, and starts a grandchild that hangs too (the group must die whole)
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const dataDir = flag('user-data-dir')
const pdf = flag('print-to-pdf')
const url = args[args.length - 1]
mkdirSync(dataDir, { recursive: true })

appendFileSync(join(dataDir, 'fake-chromium.timeline'), `start ${process.pid}\n`)
appendFileSync(join(dataDir, 'fake-chromium.calls'), `${process.pid}\n`)
const calls = readFileSync(join(dataDir, 'fake-chromium.calls'), 'utf8').trim().split('\n').length
const modesFile = join(dataDir, 'fake-chromium.modes')
const modes = existsSync(modesFile) ? readFileSync(modesFile, 'utf8').trim().split('\n') : ['pages=1']
const mode = modes[Math.min(calls, modes.length) - 1] ?? 'pages=1'
writeFileSync(join(dataDir, `fake-chromium.args.${calls}`), args.join('\0'))
const html = url.startsWith('file://') ? fileURLToPath(url) : ''
if (existsSync(html)) writeFileSync(join(dataDir, `fake-chromium.html.${calls}`), readFileSync(html))

if (mode === 'hang') {
  const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
  appendFileSync(join(dataDir, 'fake-chromium.calls'), `${grandchild.pid}\n`)
  setTimeout(() => process.exit(0), 60_000)
} else if (mode === 'fail') {
  process.stderr.write('[0101/000000.000000:ERROR:headless_shell.cc] Abnormal renderer termination.\n')
  process.exit(1)
} else if (mode === 'slow') {
  setTimeout(() => print('1'), 300)
} else if (mode !== 'no-pdf') {
  print(/^pages=(\d+)$/.exec(mode)?.[1] ?? '1')
}

function print(pages) {
  writeFileSync(pdf, `%PDF-fake pages=${pages}\n`)
  appendFileSync(join(dataDir, 'fake-chromium.timeline'), `end ${process.pid}\n`)
}
