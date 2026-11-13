/**
 * Printing a `CvDoc` and keeping it as a version's files (design D5 steps 5–7 and the layout of
 * step 8; tasks H5b). The CV run uses it, and the reprint of H5c will: the same doc and the same
 * contact give the same HTML (`renderCvHtml`), so a reprint is these steps with today's profile.
 *
 * THE PRINT goes to `<stateDir>/render/<renderId>/` (Chromium, one print per profile at a time) and is
 * counted there (`pdfinfo`). ONLY THE PRINT THAT IS KEPT moves to
 * `<stateDir>/artifacts/<applicationId>/v<k>/cv.pdf`, with page 1 as `preview.png` beside it, and the
 * render folder goes.
 *
 * THE VERSION FOLDER IS CLAIMED, NEVER REUSED: `v<k>` is made with a plain `mkdir` from the version the
 * run expects, and one that exists — left by a run the guard discarded, or by a return in between —
 * moves it to the next free `k`. A run never writes over a PDF another version points to.
 */

import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { Logger, Timers } from '@factotum/core'

import type { RunFailure } from '../ai/run.ts'
import type { CvDoc, Profile, Result } from '../types.ts'
import { printPdf } from './chromium.ts'
import { countPages, renderPreview, type Poppler } from './pdf.ts'
import { renderCvHtml } from './render.ts'

/** A value, or the failed run it makes. */
export type Found<T> = { readonly ok: true; readonly value: T } | RunFailure

export const failed = (reason: string): RunFailure => ({ ok: false, kind: 'failed', reason })
const found = <T>(value: T): Found<T> => ({ ok: true, value })
const fromResult = <T>(result: Result<T>): Found<T> => (result.ok ? result : failed(result.error.reason))

export interface PrintDeps {
  readonly stateDir: string
  readonly timers: Timers
  readonly log: Logger
  /** The bytes of `assets/Geist-Variable.latin.woff2`, read once at start (D5 step 5). */
  readonly font: Uint8Array
  /** The config's `chromium` (D13). */
  readonly chromium: string
  readonly poppler: Poppler
}

export interface Printed {
  /** In the render folder, until `keepPrint` moves it. */
  readonly pdf: string
  readonly pages: number
  /** The contact the template printed (`contactHashOf`). */
  readonly contactHash: string
}

export interface Kept {
  readonly pdf: string
  readonly png: string
}

/** A path segment of ours: never `..`, never hidden, never a separator. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const DIR_MODE = 0o700
/** How many taken version folders a run steps over before it gives up. */
const MAX_CLAIMS = 100

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'error'
}

/** Steps 5–7a: the HTML of `doc` with `profile`'s contact, printed, its pages counted. */
export async function printCv(deps: PrintDeps, renderId: string, doc: CvDoc, profile: Profile, signal: AbortSignal): Promise<Found<Printed>> {
  const { html, contactHash } = renderCvHtml(doc, profile, deps.font)
  const pdf = await printPdf({ bin: deps.chromium, stateDir: deps.stateDir, timers: deps.timers, signal }, renderId, html)
  if (!pdf.ok) return failed(pdf.error.reason)
  const pages = await countPages({ poppler: deps.poppler, timers: deps.timers, signal }, pdf.value)
  if (!pages.ok) return failed(pages.error.reason)
  return found({ pdf: pdf.value, pages: pages.value, contactHash })
}

/** `<stateDir>/artifacts/<applicationId>/v<k>`, made new, from `k = from` on. */
function claimVersionDir(stateDir: string, applicationId: string, from: number): Found<string> {
  if (!SEGMENT.test(applicationId)) return failed('an application id is letters, digits, dashes and underscores')
  const parent = join(stateDir, 'artifacts', applicationId)
  try {
    mkdirSync(parent, { recursive: true, mode: DIR_MODE })
  } catch (error) {
    return failed(`the artifacts folder could not be made (${codeOf(error)})`)
  }
  for (let k = from; k < from + MAX_CLAIMS; k += 1) {
    const dir = join(parent, `v${k}`)
    try {
      mkdirSync(dir, { mode: DIR_MODE })
      return found(dir)
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') return failed(`the version folder could not be made (${codeOf(error)})`)
    }
  }
  return failed(`no free version folder from v${from}`)
}

/** Step 7b and step 8's layout: the kept print moves to its version folder, with its preview. */
export async function keepPrint(deps: PrintDeps, applicationId: string, version: number, printed: Printed, signal: AbortSignal): Promise<Found<Kept>> {
  const dir = claimVersionDir(deps.stateDir, applicationId, version)
  if (!dir.ok) return dir
  const pdf = join(dir.value, 'cv.pdf')
  try {
    renameSync(printed.pdf, pdf)
  } catch (error) {
    return failed(`the PDF could not be moved to its version (${codeOf(error)})`)
  }
  const png = fromResult(await renderPreview({ poppler: deps.poppler, timers: deps.timers, signal }, pdf, dir.value))
  return png.ok ? found({ pdf, png: png.value }) : png
}

/** The render folder of a run, gone. A failure costs disk only: said, never the run's. */
export function clearRender(deps: PrintDeps, renderId: string): void {
  if (!SEGMENT.test(renderId)) return
  try {
    rmSync(join(deps.stateDir, 'render', renderId), { recursive: true, force: true })
  } catch (error) {
    deps.log.warn(`jobs cv: the render folder ${renderId} could not be removed (${codeOf(error)})`)
  }
}
