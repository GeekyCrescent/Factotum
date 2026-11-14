/**
 * Counting the pages of the printed CV and taking its preview, with the host's Poppler (design D5
 * step 7; tasks H3). Each binary runs in its own group with 15 s (`runProcess`).
 *
 * THE PREVIEW IS PAGE 1 OF THE PDF THAT IS SENT, not a screenshot of the HTML that might break
 * differently. A2 measured `pdfinfo`'s `Pages:` against what is seen on 10/10 PDFs of 1–4 pages, so
 * counting by `pdfinfo` is reliable; p95 0.010 s and 0.20 s against a 15 s timeout.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { Timers } from '@factotum/core'

import { fail, ok, type Result } from '../types.ts'
import { runProcess, type ProcessInput } from './process.ts'

/** design D5 step 7: 15 s each. */
export const POPPLER_TIMEOUT_MS = 15_000
/** A2: `-r 110` is 909 × 1287 px, readable in a 600 px column. */
export const PREVIEW_DPI = 110
export const PREVIEW_NAME = 'preview'

/** The config's `poppler` (D13): absolute paths. */
export interface Poppler {
  readonly pdfinfo: string
  readonly pdftoppm: string
}

export interface PopplerRun {
  readonly poppler: Poppler
  readonly timers: Timers
  readonly signal?: AbortSignal
}

const PAGES_LINE = /^Pages:\s+(\d+)\s*$/m

/** The `Pages: N` line of `pdfinfo`'s output. Pure. */
export function pagesOf(stdout: string): Result<number> {
  const pages = Number(PAGES_LINE.exec(stdout)?.[1] ?? 0)
  return pages >= 1 ? ok(pages) : fail('module-error', 'pdfinfo printed no Pages: line')
}

const DIR_MODE = 0o700

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'error'
}

/** `--` ends the options (Poppler 26 accepts it): a path can never be read as one. */
export async function countPages(run: PopplerRun, pdf: string): Promise<Result<number>> {
  const info = await runProcess({ name: 'pdfinfo', bin: run.poppler.pdfinfo, args: ['--', pdf], ...processOf(run) })
  return info.ok ? pagesOf(info.value) : info
}

/** Page 1 of `pdf` as `<dir>/preview.png` (`dir` 0700); the path. A preview left there before is removed first. */
export async function renderPreview(run: PopplerRun, pdf: string, dir: string): Promise<Result<string>> {
  const prefix = join(dir, PREVIEW_NAME)
  const png = `${prefix}.png`
  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    // So an exit 0 that wrote nothing is never taken for a preview (as `printPdf` does with the PDF).
    rmSync(png, { force: true })
  } catch (error) {
    return fail('module-error', `the preview folder could not be made (${codeOf(error)})`)
  }
  const args = ['-png', '-r', String(PREVIEW_DPI), '-f', '1', '-l', '1', '-singlefile', '--', pdf, prefix]
  const done = await runProcess({ name: 'pdftoppm', bin: run.poppler.pdftoppm, args, ...processOf(run) })
  if (!done.ok) return done
  return existsSync(png) ? ok(png) : fail('module-error', `pdftoppm wrote no ${PREVIEW_NAME}.png`)
}

function processOf(run: PopplerRun): Pick<ProcessInput, 'timers' | 'timeoutMs' | 'signal'> {
  return { timers: run.timers, timeoutMs: POPPLER_TIMEOUT_MS, ...(run.signal === undefined ? {} : { signal: run.signal }) }
}
