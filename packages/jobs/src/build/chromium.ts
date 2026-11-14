/**
 * Printing the CV's HTML to PDF with the host's Chromium (design D5 step 6; tasks H4): one process in
 * its own group, 30 s on the injected timers (`runProcess`).
 *
 * THE COMMAND IS D5's, AS A2 LEFT IT: `--user-data-dir=<stateDir>/chromium` of its own, because
 * `omarchy` is a desktop and the owner's open Chromium must never receive the order (A2 measured it
 * does not: the headless one prints by itself, without touching the owner's processes or profile).
 * No `--no-sandbox` (≈ 50 runs, exit 0), no `--headless=new` (in 152 `--headless` is already the new
 * mode), no profile per run. The binary is the config's `chromium`, `/usr/lib/chromium/chromium` by
 * default — not the launcher that adds the owner's `chromium-flags.conf`. Three flags on top of D5's,
 * hardening only: `--disable-extensions`, `--no-first-run`, `--disable-background-networking` (no
 * extension, no first-run work, no component updates or other background requests from the profile).
 *
 * THE HTML GOES TO `<stateDir>/render/<id>/cv.html` and the PDF next to it. A PDF left there by an
 * earlier print is removed first, so an exit 0 that wrote nothing is never taken for a print.
 */

import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Timers } from '@factotum/core'

import { fail, ok, type Result } from '../types.ts'
import { runProcess } from './process.ts'

/** design D5 step 6; A2: p95 0.35 s, ~85× of margin. */
export const CHROMIUM_TIMEOUT_MS = 30_000

/** A folder name under `render/`: never a path, never hidden, never `..`. */
const RENDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const DIR_MODE = 0o700

export interface ChromiumRun {
  /** The config's `chromium` (D13): absolute. */
  readonly bin: string
  readonly stateDir: string
  readonly timers: Timers
  readonly signal?: AbortSignal
}

/** The arguments, pure (D5 step 6). */
export function chromiumArgs(stateDir: string, html: string, pdf: string): readonly string[] {
  return [
    '--headless',
    '--disable-gpu',
    '--no-pdf-header-footer',
    // Nothing on the side: none of these touches layout or print, so A2's measurements still hold.
    '--disable-extensions',
    '--no-first-run',
    '--disable-background-networking',
    `--user-data-dir=${join(stateDir, 'chromium')}`,
    `--print-to-pdf=${pdf}`,
    pathToFileURL(html).href,
  ]
}

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'error'
}

/** Writes the HTML and clears an old PDF; the two paths. */
function prepare(stateDir: string, renderId: string, html: string): Result<{ readonly html: string; readonly pdf: string }> {
  const dir = join(stateDir, 'render', renderId)
  const paths = { html: join(dir, 'cv.html'), pdf: join(dir, 'cv.pdf') }
  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    writeFileSync(paths.html, html, { mode: 0o600 })
    rmSync(paths.pdf, { force: true })
    return ok(paths)
  } catch (error) {
    return fail('module-error', `the render folder could not be written (${codeOf(error)})`)
  }
}

function printed(pdf: string): boolean {
  try {
    return statSync(pdf).size > 0
  } catch {
    return false
  }
}

/**
 * The tail of the prints queued on each `--user-data-dir`: two Chromiums on one profile fight over its
 * lock (the second may hand its order to the first and exit 0 with no PDF), so prints on the same
 * state folder run one after the other. The queue runs one `reprint` at a time, but a CV run prints
 * too (H5a), and nothing else serialised the two.
 */
const printing = new Map<string, Promise<unknown>>()

function oneAtATime<T>(key: string, job: () => Promise<T>): Promise<T> {
  const before = printing.get(key) ?? Promise.resolve()
  const mine = before.then(job, job)
  const tail = mine.then(
    () => undefined,
    () => undefined,
  )
  printing.set(key, tail)
  // The last one out removes its key, so the map does not grow with every state folder ever seen.
  void tail.then(() => {
    if (printing.get(key) === tail) printing.delete(key)
  })
  return mine
}

/** Prints `html` as `<stateDir>/render/<renderId>/cv.pdf`; the PDF's path. One print per profile at a time. */
export async function printPdf(run: ChromiumRun, renderId: string, html: string): Promise<Result<string>> {
  if (!RENDER_ID.test(renderId)) return fail('invalid', 'a render id is letters, digits, dashes and underscores')
  return oneAtATime(resolve(run.stateDir, 'chromium'), () => printNow(run, renderId, html))
}

async function printNow(run: ChromiumRun, renderId: string, html: string): Promise<Result<string>> {
  if (run.signal?.aborted === true) return fail('module-error', 'stopped')
  const paths = prepare(run.stateDir, renderId, html)
  if (!paths.ok) return paths
  const done = await runProcess({
    name: 'chromium',
    bin: run.bin,
    args: chromiumArgs(run.stateDir, paths.value.html, paths.value.pdf),
    timers: run.timers,
    timeoutMs: CHROMIUM_TIMEOUT_MS,
    ...(run.signal === undefined ? {} : { signal: run.signal }),
  })
  if (!done.ok) return done
  return printed(paths.value.pdf) ? ok(paths.value.pdf) : fail('module-error', 'chromium wrote no PDF')
}
