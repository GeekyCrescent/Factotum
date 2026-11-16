/**
 * The reprint (design D5 «Reimpresión», D10 `reprint`, D3 «`cv-stale`»; tasks H5c): the queue's handler
 * for `kind: 'reprint'`, and the two ways one is asked for besides a profile save.
 *
 * WHAT IT DOES: D5 steps 5–7 again — `printFitted`, `keepPrint`, `clearRender`, through the same printer
 * the rewrite uses — with the SAME `CvDoc` of the current version and TODAY's profile. NO CLAUDE: the
 * text cannot change, so the HTML is the one the same doc and contact always give (`renderCvHtml`).
 * It prints at the DENSITY the version was kept at (H6), and goes on to the tighter ones only if the new
 * contact makes it run long — never back to a looser one. It answers a new version `origin: 'reprinted'` with the new PDF, PNG and `contactHash`; the queue
 * writes it (the guard of G4: a newer request of class `cv` discards it) and re-lints it (T-A5). More
 * than one page is `cv-overflow`, with no «shorter»: that one is Claude, and the owner's to ask for.
 *
 * NOTHING TO DO is a run that prints nothing: an application no longer `in-review`/`ready` (D5: only
 * the unsent are reprinted) writes nothing. One whose printed contact is today's again (the owner changed
 * it back while the re-lint skipped it, the vault offline) is RE-LINTED instead (`relintOne`), so its
 * `cv-stale` clears; with the vault still offline that re-lint fails, and the run is a failed attempt
 * (the queue's retries, then `reprint-failed`). The queue never queues a reprint after one that printed
 * nothing (`reprintIfStale`): that is what kept a stale-but-current CV reprinting forever.
 *
 * A REPRINT THAT FAILS (Chromium, Poppler) is a failed attempt; the third leaves `cv-stale` with
 * `reprint-failed { reason }` (`returns.ts`), and «Retry print» (`retryPrint`) queues another.
 */

import type { EnqueueSpec, JobHandler, JobResult, RelintFn } from '../ai/queue.ts'
import type { PrintFn } from '../review/rewrite.ts'
import type { Db, Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { fail, ok, type Application, type Result, type Warning } from '../types.ts'
import { failed } from './print.ts'
import { contactHashOf } from './render.ts'

export interface ReprintDeps {
  readonly db: Db
  /** D5 steps 5–7 with today's profile (`printer` of `facade/sources.ts`). */
  readonly print: PrintFn
  /** L4's one-row re-lint: a CV whose printed contact is today's again only needs its warnings redone. */
  readonly relintOne: RelintFn
}

/** The states a reprint is for (D3 «`cv-stale`»): unsent and unapproved. */
const REPRINTABLE: ReadonlySet<Application['state']> = new Set<Application['state']>(['in-review', 'ready'])
const PENDING: ReadonlySet<string> = new Set(['queued', 'running'])

const NOTHING: JobResult = { ok: true, output: { type: 'apply', apply: () => ok(undefined) } }

const isStale = (app: Application): boolean => app.warnings.some((w) => w.code === 'cv-stale' && w.overridden === null)

/** The latest request of class `cv` of this application, when it is queued or running. */
function cvPending(q: Queries, applicationId: string): boolean {
  return repo.genRequestsOf(q, applicationId).some((r) => r.kind === 'cv' && r.state !== null && PENDING.has(r.state))
}

/**
 * Whether `app` waits for a reprint nobody asked for (D3 «`cv-stale`»): reviewable, `cv-stale`, and no
 * request of class `cv` pending. `after` is the work whose return is being written: when it is of class
 * `cv` and a NEWER request of that class overtook it, the newer one owns the CV — never a reprint here.
 */
export function awaitsReprint(q: Queries, app: Application, after?: { readonly workId: string; readonly writesCv: boolean }): boolean {
  if (!REPRINTABLE.has(app.state) || !isStale(app) || cvPending(q, app.id)) return false
  if (after === undefined || !after.writesCv) return true
  const latest = repo.genRequestsOf(q, app.id).find((r) => r.kind === 'cv')
  return latest === undefined || latest.workId === after.workId
}

/**
 * «Retry print» (D3, A6): another reprint of an application whose reprint failed, inside the caller's
 * `tx`; the caller pumps after. Refused when it is not reviewable, not out of date, or one is pending.
 */
export function retryPrint(q: Queries, enqueue: (q: Queries, spec: EnqueueSpec) => Result<repo.Work>, applicationId: string): Result<repo.Work> {
  const app = repo.getApplication(q, applicationId)
  if (app === undefined) return fail('not-found', 'no such application')
  if (!REPRINTABLE.has(app.state)) return fail('conflict', 'only a CV waiting for review is reprinted')
  if (!isStale(app)) return fail('conflict', 'the CV carries the contact of today already')
  if (cvPending(q, app.id)) return fail('conflict', 'the CV is being printed already')
  return enqueue(q, { kind: 'reprint', ref: app.id })
}

/** More than one page: `cv-overflow`, and no «shorter» (D5). */
const overflowOf = (pages: number): readonly Warning[] =>
  pages > 1 ? [{ code: 'cv-overflow', where: 'cv', detail: `the CV prints on ${pages} pages`, blocks: true, overridden: null }] : []

/** Nothing to print: the re-lint of the row, in the return's `tx` (its failure is the run's). */
const relinted = (deps: ReprintDeps, applicationId: string): JobResult => ({
  ok: true,
  output: { type: 'apply', apply: (q, now) => deps.relintOne(q, { kind: 'application', id: applicationId }, now) },
})

export function createReprintHandler(deps: ReprintDeps): JobHandler {
  return async (work, ctx) => {
    const read = deps.db.read((q) => {
      const app = repo.getApplication(q, work.ref)
      const artifacts = app === undefined ? undefined : repo.getArtifacts(q, app.id, app.version)
      return { app, artifacts, profile: repo.latestProfileVersion(q) }
    })
    const { app, artifacts, profile } = read
    if (app === undefined) return failed('no such application')
    if (profile === undefined) return failed('there is no profile to print with')
    if (!REPRINTABLE.has(app.state)) return NOTHING
    if (artifacts?.contactHash === contactHashOf(profile.profile)) return relinted(deps, app.id)
    if (artifacts?.cv === null || artifacts?.cv === undefined) return failed('there is no CV to reprint')
    // The profile read once, here: the PDF is printed with it and the version names it.
    const printed = await deps.print({ applicationId: app.id, version: app.version + 1, cv: artifacts.cv, signal: ctx.signal, profile, from: artifacts.density ?? 'normal' })
    if (!printed.ok) return failed(`the print failed: ${printed.error.reason}`)
    const { pages, ...files } = printed.value
    return {
      ok: true,
      output: {
        type: 'application',
        artifacts: { ...files, profileVersion: profile.version, rules: artifacts.rules, usage: null, origin: 'reprinted' },
        warnings: overflowOf(pages),
      },
    }
  }
}
