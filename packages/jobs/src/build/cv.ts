/**
 * The CV builder, as the queue's handler of `cv` works (design D5 «La corrida»; tasks H5a, H5b).
 *
 * STEPS 1–4 (H5a): the prompt (`prompts/cv.ts`: the fixed part as a system FILE, what changes by
 * stdin), one `claude -p` run, a `CvDoc` validated by zod and its draft-07 schema. THE LINTER (step 4)
 * IS THE QUEUE'S, INJECTED THERE (`QueueDeps.lint`): it lints the version this run brings back, with
 * the PDF already on disk, in the `tx` that saves it — so a block never cuts the run here; the run
 * goes on, and the transition of step 8 (`in-review` with a block, `ready` without) is the return's.
 *
 * STEPS 5–8 (H5b, `print.ts`): paint with the profile's contact, print, count the pages. More than one
 * → «shorter» ONCE (back to step 1 with the previous CV and `SHORTER`); still more → `cv-overflow`,
 * which blocks. The kept print goes to `<stateDir>/artifacts/<id>/v<k>/`, and THE VERIFIER (injected,
 * L3) reads the CV this run wrote. Its `unsupported-claim`s and `cv-overflow` go back with the version
 * (`JobOutput.warnings`); a verifier that could not run fails the attempt — a CV is never `ready` unchecked.
 *
 * EVERYTHING THE RUN READS IS READ AT ITS START, IN ONE `read`: the application, its current version,
 * the opportunity, the company and its record, today's profile and the enabled rules of its channel.
 * What it brings back goes to the queue as an `application` output; the queue saves it as a new
 * version in its own `tx`, behind the guard of D3 (a newer request of the same class discards it).
 *
 * NOTHING THROWS OUT OF HERE: a missing row, a source that cannot be read, a run or a print that fails —
 * each is `{ ok: false, kind, reason }`, and the queue counts it (D10).
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Logger, Timers } from '@factotum/core'
import type { z } from 'zod'

import { buildCvPrompt, type CvPromptInput } from '../ai/prompts/cv.ts'
import { writeSystemFile } from '../ai/prompts/fixed.ts'
import type { ArtifactsPatch, JobContext, JobHandler, JobResult } from '../ai/queue.ts'
import { isPause, runClaude, type RunFailure, type RunResult } from '../ai/run.ts'
import { CV_DOC_OUTPUT, CV_DOC_JSON_SCHEMA } from '../ai/schemas.ts'
import { enabledRules } from '../rules.ts'
import type { Db } from '../store/db.ts'
import { companyRecord, getApplication, getArtifacts, getCompany, getOpportunity, latestProfileVersion, type Work } from '../store/repo.ts'
import type { Application, Artifacts, Company, CvDoc, Opportunity, ProfileVersion, Result, Rule, RunUsage, Warning } from '../types.ts'
import { clearRender, failed, keepPrint, printCv, type Found, type PrintDeps, type Printed } from './print.ts'

export type { Found } from './print.ts'

/** D5 step 7: the one instruction of the «shorter» pass. */
export const SHORTER =
  'This CV prints on more than one A4 page. Make it fit on one page: cut the weakest bullets, projects and skills first. Change nothing else, and add nothing.'

/** What the verifier reads (L3): the texts of a version, and where they came from (the seed's are never checked). */
export interface VerifyTarget {
  readonly cv: CvDoc | null
  readonly letter: string | null
  readonly origin: Artifacts['origin']
}

export type VerifyOutcome = { readonly ok: true; readonly warnings: readonly Warning[]; readonly usage: RunUsage | null } | RunFailure

/** The verifier of D6 (`createVerifier`, L3), injected. */
export type VerifyFn = (target: VerifyTarget, ctx: JobContext) => Promise<VerifyOutcome>

/** What is read from the vault for every CV: the master CV, the guide and the base versions of `01-cvs.md` (D8). */
export interface CvSources {
  readonly master: string
  readonly guide: string
  readonly bases: Readonly<Partial<Record<'A' | 'B', string>>>
}

export interface ClaudeSettings {
  /** `models.write` (D10: `sonnet`). */
  readonly model: string
  readonly effort: string | undefined
  /** The seam for `fake-claude`; absent = the real binary. */
  readonly bin?: string | undefined
}

export interface CvBuilderDeps extends PrintDeps, FixedRunDeps {
  readonly db: Db
  /** Read at the start of every run: a changed master CV is the next run's (and a new system file). */
  readonly sources: () => Result<CvSources>
  readonly verify: VerifyFn
}

/** Everything one run reads of the store, at its start. */
export interface CvJob {
  readonly app: Application
  readonly current: Artifacts | undefined
  readonly opportunity: Opportunity
  readonly company: Company & { readonly record: string }
  readonly profile: ProfileVersion
  readonly rules: readonly Rule[]
}

/** The store's part of a run, or why it cannot run. */
export function readJob(db: Db, applicationId: string): Found<CvJob> {
  return db.read((q): Found<CvJob> => {
    const app = getApplication(q, applicationId)
    if (app === undefined) return failed('no such application')
    const opportunity = getOpportunity(q, app.opportunityId)
    const company = getCompany(q, app.companyId)
    const profile = latestProfileVersion(q)
    if (opportunity === undefined || company === undefined) return failed('the application has no opportunity or company')
    if (profile === undefined) return failed('there is no profile')
    const record = companyRecord(q, company.id) ?? ''
    const value = { app, current: getArtifacts(q, app.id, app.version), opportunity, company: { ...company, record }, profile, rules: enabledRules(q, app.channel) }
    return { ok: true, value }
  })
}

/** The prompt's input for this job; `previous` for the «shorter» pass. */
export function promptInput(job: CvJob, sources: CvSources, previous?: CvPromptInput['previous']): CvPromptInput {
  const label = job.app.cvBase
  const baseText = label === null ? undefined : sources.bases[label]
  return {
    master: sources.master,
    guide: sources.guide,
    profile: job.profile.profile,
    rules: job.rules.map((rule) => rule.text),
    base: label === null || baseText === undefined ? null : { label, text: baseText },
    company: job.company,
    opportunity: job.opportunity,
    letter: job.current?.letter?.body ?? null,
    ...(previous === undefined ? {} : { previous }),
  }
}

/** What a run with the fixed part needs: where to write it and run, and how to call Claude. */
export interface FixedRunDeps {
  readonly stateDir: string
  readonly now: () => Date
  readonly timers: Timers
  readonly log: Logger
  readonly claude: ClaudeSettings
}

/** One `claude -p` with `prompt.system` as the system file and `prompt.stdin` by stdin, in `<stateDir>/run`. */
export async function runFixed<T>(
  deps: FixedRunDeps,
  prompt: { readonly system: string; readonly stdin: string },
  schema: { readonly json: string; readonly output: z.ZodType<T> },
  ctx: JobContext,
): Promise<RunResult<T>> {
  const systemFile = writeSystemFile(deps.stateDir, prompt.system)
  if (!systemFile.ok) return failed(systemFile.error.reason)
  const cwd = join(deps.stateDir, 'run')
  try {
    mkdirSync(cwd, { recursive: true, mode: 0o700 })
  } catch {
    return failed('the run folder could not be made')
  }
  return runClaude({
    prompt: prompt.stdin,
    systemFile: systemFile.value,
    jsonSchema: schema.json,
    output: schema.output,
    model: deps.claude.model,
    effort: deps.claude.effort,
    cwd,
    timers: deps.timers,
    now: deps.now,
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
    log: deps.log,
    ...(deps.claude.bin === undefined ? {} : { bin: deps.claude.bin }),
  })
}

/** Steps 1–3: one run of Claude for this input, a `CvDoc` that passed the schema. */
export function writeCvDoc(deps: CvBuilderDeps, input: CvPromptInput, ctx: JobContext): Promise<RunResult<CvDoc>> {
  return runFixed(deps, buildCvPrompt(input), { json: CV_DOC_JSON_SCHEMA, output: CV_DOC_OUTPUT }, ctx)
}

/** Two runs' usage as one: the counters and the cost added, the first run's model. */
export function addUsage(a: RunUsage | null, b: RunUsage | null): RunUsage | null {
  if (a === null || b === null) return a ?? b
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
    ms: a.ms + b.ms,
    model: a.model ?? b.model,
  }
}

/** A CV written and printed: the doc kept, what it cost, its print. */
interface Fitted {
  readonly doc: CvDoc
  readonly usage: RunUsage | null
  readonly printed: Printed
}

/** Steps 1–7a: write and print; on more than one page, «shorter» once and print again. */
async function fitOnePage(deps: CvBuilderDeps, job: CvJob, sources: CvSources, renderId: string, ctx: JobContext): Promise<Found<Fitted>> {
  const first = await writeCvDoc(deps, promptInput(job, sources), ctx)
  if (!first.ok) return first
  const printed = await printCv(deps, renderId, first.value, job.profile.profile, ctx.signal)
  if (!printed.ok) return printed
  if (printed.value.pages <= 1) return { ok: true, value: { doc: first.value, usage: first.usage, printed: printed.value } }
  const shorter = await writeCvDoc(deps, promptInput(job, sources, { doc: first.value, instruction: SHORTER }), ctx)
  if (!shorter.ok) return shorter
  const again = await printCv(deps, renderId, shorter.value, job.profile.profile, ctx.signal)
  if (!again.ok) return again
  return { ok: true, value: { doc: shorter.value, usage: addUsage(first.usage, shorter.usage), printed: again.value } }
}

const blocking = (code: Warning['code'], detail: string): Warning => ({ code, where: 'cv', detail, blocks: true, overridden: null })

/** The reason of a CV whose verifier did not run: the attempt fails, the queue retries (D10). */
export const UNCHECKED_PREFIX = 'the check did not run: '

/**
 * Step 8's check. A verifier that does not run FAILS THE ATTEMPT (a limit or a logged-out CLI stays a pause, with no
 * attempt counted): the queue's retries at 2 and 10 min, and the third failure is T-A3's `missing-cv`
 * with «Retry». Never an `unsupported-claim` «I checked it» could clear on a CV nobody checked.
 */
async function verifyCv(deps: CvBuilderDeps, doc: CvDoc, ctx: JobContext): Promise<Found<{ readonly warnings: readonly Warning[]; readonly usage: RunUsage | null }>> {
  const checked = await deps.verify({ cv: doc, letter: null, origin: 'generated' }, ctx)
  if (checked.ok) return { ok: true, value: checked }
  deps.log.warn(`jobs cv: the verifier did not run (${checked.reason})`)
  return isPause(checked) ? checked : failed(`${UNCHECKED_PREFIX}${checked.reason}`)
}

/** Steps 8 then 7b: verified first (nothing unchecked is kept), the print in its version folder; what goes back to the queue. */
async function keepAndVerify(deps: CvBuilderDeps, job: CvJob, fitted: Fitted, ctx: JobContext): Promise<JobResult> {
  const { doc, printed } = fitted
  const checked = await verifyCv(deps, doc, ctx)
  if (!checked.ok) return checked
  const kept = await keepPrint(deps, job.app.id, job.app.version + 1, printed, ctx.signal)
  if (!kept.ok) return kept
  const overflow = printed.pages > 1 ? [blocking('cv-overflow', `the CV prints on ${printed.pages} pages`)] : []
  const artifacts: ArtifactsPatch = {
    cv: doc,
    pdf: kept.value.pdf,
    png: kept.value.png,
    contactHash: printed.contactHash,
    profileVersion: job.profile.version,
    rules: job.rules.map((rule) => rule.id),
    usage: addUsage(fitted.usage, checked.value.usage),
    origin: 'generated',
  }
  return { ok: true, output: { type: 'application', artifacts, warnings: [...checked.value.warnings, ...overflow] } }
}

async function build(deps: CvBuilderDeps, work: Work, ctx: JobContext): Promise<JobResult> {
  const job = readJob(deps.db, work.ref)
  if (!job.ok) return job
  const sources = deps.sources()
  if (!sources.ok) return failed(sources.error.reason)
  try {
    const fitted = await fitOnePage(deps, job.value, sources.value, work.id, ctx)
    return fitted.ok ? await keepAndVerify(deps, job.value, fitted.value, ctx) : fitted
  } finally {
    // Whatever came of the run, its render folder goes.
    clearRender(deps, work.id)
  }
}

/** The handler of `cv` works: `createQueue({ handlers: { cv: createCvHandler(deps) } })`. */
export function createCvHandler(deps: CvBuilderDeps): JobHandler {
  return (work, ctx) => build(deps, work, ctx)
}
