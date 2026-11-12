/**
 * The live ad (task N3, design D9 «El anuncio vivo»; requirements crit. 24).
 *
 * A vacancy in review is re-read when its last check is older than `AD_STALE_MS` (24 h): `GET` of the
 * opportunity's `url` through the injected `Net`. Closed is, by the markers measured in A6:
 * - `404` / `410` (Greenhouse, Lever, YC…);
 * - SEEK, which answers a closed ad with `200`: in `window.SEEK_REDUX_DATA.jobdetails.result.job`,
 *   `isExpired === true` or `status === "Expired"`; only when that cannot be parsed, the attribute
 *   `data-automation="expiredJobPage"`; as a last resort the visible «This job is no longer advertised»;
 * - We Work Remotely: a redirect to its home page.
 * A closed ad adds the warning `ad-closed` (blocking, so «Skip» is what the card proposes; the owner
 * may override it) through the `relint` transition (T-A6: `ready → in-review`), and the opportunity is
 * `closed`. Every finished read moves the opportunity's `checkedAt`, an answer or not, so a site that
 * refuses is asked again in 24 h, not every tick.
 *
 * Runs in the background (crit. 46b), never inside «Start review»: the network is outside any `tx`.
 */

import type { Net, NetResult, Page } from '../scout/net.ts'
import { appTransition } from '../state.ts'
import type { Db } from '../store/db.ts'
import { getApplication, getOpportunity, saveApplication, saveOpportunityCheck } from '../store/repo.ts'
import { fail, ok, type Application, type Opportunity, type Result, type Warning } from '../types.ts'

/** design D9: an ad is re-read when its last check is older than this. */
export const AD_STALE_MS = 24 * 3_600_000

export type AdClosedReason = 'http-404' | 'http-410' | 'seek-expired' | 'seek-expired-page' | 'seek-no-longer-advertised' | 'redirected-home'

export type AdVerdict =
  | { readonly kind: 'open' }
  | { readonly kind: 'closed'; readonly reason: AdClosedReason }
  /** No verdict: net's failure (`network`, `timeout`…) or `http-<status>`. */
  | { readonly kind: 'unreachable'; readonly reason: string }

export type NotChecked = 'fresh' | 'not-a-vacancy' | 'no-url' | 'closed' | 'not-in-review'

export type RevalidateOutcome =
  | { readonly checked: true; readonly verdict: AdVerdict }
  | { readonly checked: false; readonly why: NotChecked; readonly verdict: null }

const REVIEWED: readonly Application['state'][] = ['in-review', 'ready']
const SEEK_NO_LONGER = /this job is no longer advertised/i

// ── Reading the page ─────────────────────────────────────────────────────────────────────────────

const isSeek = (host: string): boolean => ['seek.com.au', 'seek.com'].some((domain) => host === domain || host.endsWith(`.${domain}`))
const isWwr = (host: string): boolean => host === 'weworkremotely.com' || host === 'www.weworkremotely.com'

/** The JSON object that starts at `start` (a `{`), by balanced braces outside strings; null when it never closes. */
function objectAt(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (char === '\\') i++
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

interface SeekJob {
  readonly isExpired?: unknown
  readonly status?: unknown
}

/** `window.SEEK_REDUX_DATA.jobdetails.result.job`, or null when it is not there or not JSON. */
function seekJob(body: string): SeekJob | null {
  const at = /SEEK_REDUX_DATA\s*=\s*/.exec(body)
  if (at === null) return null
  const start = at.index + at[0].length
  if (body[start] !== '{') return null
  const raw = objectAt(body, start)
  if (raw === null) return null
  try {
    const data = JSON.parse(raw) as { jobdetails?: { result?: { job?: SeekJob } } }
    const job = data.jobdetails?.result?.job
    return typeof job === 'object' && job !== null ? job : null
  } catch {
    return null
  }
}

function seekVerdict(body: string): AdVerdict {
  const job = seekJob(body)
  if (job !== null) return job.isExpired === true || job.status === 'Expired' ? { kind: 'closed', reason: 'seek-expired' } : { kind: 'open' }
  if (/data-automation\s*=\s*["']expiredJobPage["']/.test(body)) return { kind: 'closed', reason: 'seek-expired-page' }
  if (SEEK_NO_LONGER.test(body)) return { kind: 'closed', reason: 'seek-no-longer-advertised' }
  return { kind: 'open' }
}

/** Pure: what a `GET` of the ad says. */
export function classifyAd(requested: string, result: NetResult<Page>): AdVerdict {
  if (!result.ok) return { kind: 'unreachable', reason: result.error.kind }
  const page = result.value
  if (page.status === 404 || page.status === 410) return { kind: 'closed', reason: `http-${page.status}` }
  if (page.status < 200 || page.status >= 300) return { kind: 'unreachable', reason: `http-${page.status}` }
  const asked = new URL(requested)
  const landed = new URL(page.url)
  if (isWwr(asked.hostname) && page.redirects.length > 0 && landed.pathname === '/' && asked.pathname !== '/') return { kind: 'closed', reason: 'redirected-home' }
  if (isSeek(landed.hostname)) return seekVerdict(page.body)
  return { kind: 'open' }
}

// ── On the store ─────────────────────────────────────────────────────────────────────────────────

const isFresh = (opportunity: Opportunity, now: Date): boolean =>
  opportunity.checkedAt !== null && now.getTime() - new Date(opportunity.checkedAt).getTime() <= AD_STALE_MS

function whyNot(app: Application, opportunity: Opportunity, now: Date): NotChecked | null {
  if (!REVIEWED.includes(app.state)) return 'not-in-review'
  if (opportunity.kind !== 'vacancy') return 'not-a-vacancy'
  if (opportunity.url === null) return 'no-url'
  if (opportunity.status !== 'open') return 'closed'
  return isFresh(opportunity, now) ? 'fresh' : null
}

const adClosed = (reason: AdClosedReason): Warning => ({ code: 'ad-closed', where: 'ad', detail: `the ad is closed (${reason}): skip it?`, blocks: true, overridden: null })

export interface RevalidateDeps {
  readonly db: Db
  readonly net: Net
  readonly now: () => Date
}

/** Writes the verdict: the opportunity always, the application when the ad closed and it is still in review. */
function record(db: Db, applicationId: string, opportunity: Opportunity, verdict: AdVerdict, now: Date): Result<void> {
  return db.tx((q) => {
    const closed = verdict.kind === 'closed'
    const reason = verdict.kind === 'open' ? 'open' : verdict.reason
    const checked: Opportunity = { ...opportunity, checkedAt: now.toISOString(), status: closed ? 'closed' : opportunity.status }
    const data = verdict.kind === 'unreachable' ? { closed, reason, unreachable: true } : { closed, reason }
    saveOpportunityCheck(q, checked, { kind: 'ad-checked', data }, now)
    if (verdict.kind !== 'closed') return ok(undefined)
    const app = getApplication(q, applicationId)
    if (app === undefined || !REVIEWED.includes(app.state) || app.warnings.some((w) => w.code === 'ad-closed')) return ok(undefined)
    // A blocking warning keeps it in review whatever the PDF: `pdfExists` does not decide here.
    const moved = appTransition(app, { type: 'relint', pdfExists: true, warnings: [...app.warnings, adClosed(verdict.reason)] }, now)
    if (!moved.ok) return moved
    saveApplication(q, moved.value, { kind: 'ad-checked', data: { closed, reason, from: app.state, to: moved.value.state } }, now)
    return ok(undefined)
  })
}

/** Never throws. The `GET` honours `signal` (a deadline of the caller's). */
export async function revalidateAd(deps: RevalidateDeps, applicationId: string, signal?: AbortSignal): Promise<Result<RevalidateOutcome>> {
  const found = deps.db.read((q) => {
    const app = getApplication(q, applicationId)
    return app === undefined ? undefined : { app, opportunity: getOpportunity(q, app.opportunityId) }
  })
  if (found?.opportunity === undefined) return fail('not-found', 'no such application')
  const { app, opportunity } = found
  const why = whyNot(app, opportunity, deps.now())
  if (why !== null) return ok({ checked: false, why, verdict: null })

  const url = opportunity.url ?? ''
  const verdict = classifyAd(url, await deps.net.get(url, signal === undefined ? {} : { signal }))
  const written = record(deps.db, applicationId, opportunity, verdict, deps.now())
  return written.ok ? ok({ checked: true, verdict }) : written
}
