/**
 * The CV builder, as the queue's handler of `cv` works (design D5 «La corrida»; tasks H5a, H5b).
 *
 * STEPS 1–4 (H5a): the prompt (`prompts/cv.ts`: the fixed part as a system FILE, what changes by
 * stdin), one `claude -p` run, a `CvDoc` validated by zod and its draft-07 schema. THE LINTER (step 4)
 * IS THE QUEUE'S, INJECTED THERE (`QueueDeps.lint`): it lints the version this run brings back, with
 * the PDF already on disk, in the `tx` that saves it — so a block never cuts the run here; the run
 * goes on, and the transition of step 8 (`in-review` with a block, `ready` without) is the return's.
 *
 * EVERYTHING THE RUN READS IS READ AT ITS START, IN ONE `read`: the application, its current version,
 * the opportunity, the company and its record, today's profile and the enabled rules of its channel.
 * What it brings back goes to the queue as an `application` output; the queue saves it as a new
 * version in its own `tx`, behind the guard of D3 (a newer request of the same class discards it).
 *
 * NOTHING THROWS OUT OF HERE: a missing row, a source that cannot be read, a run that fails — each is
 * `{ ok: false, kind, reason }`, and the queue counts it (D10).
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Logger, Timers } from '@factotum/core'

import { buildCvPrompt, type CvPromptInput } from '../ai/prompts/cv.ts'
import { writeSystemFile } from '../ai/prompts/fixed.ts'
import type { ArtifactsPatch, JobContext, JobHandler, JobResult } from '../ai/queue.ts'
import { runClaude, type RunFailure, type RunResult } from '../ai/run.ts'
import { CV_DOC_OUTPUT, CV_DOC_JSON_SCHEMA } from '../ai/schemas.ts'
import { enabledRules } from '../rules.ts'
import type { Db } from '../store/db.ts'
import { companyRecord, getApplication, getArtifacts, getCompany, getOpportunity, latestProfileVersion, type Work } from '../store/repo.ts'
import type { Application, Artifacts, Company, CvDoc, Opportunity, ProfileVersion, Result, Rule } from '../types.ts'

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

export interface CvBuilderDeps {
  readonly db: Db
  readonly stateDir: string
  readonly now: () => Date
  readonly timers: Timers
  readonly log: Logger
  /** Read at the start of every run: a changed master CV is the next run's (and a new system file). */
  readonly sources: () => Result<CvSources>
  readonly claude: ClaudeSettings
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

/** A value, or the failed run it makes. */
export type Found<T> = { readonly ok: true; readonly value: T } | RunFailure

const failed = (reason: string): RunFailure => ({ ok: false, kind: 'failed', reason })

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

/** Steps 1–3: one run of Claude for this input, a `CvDoc` that passed the schema. */
export async function writeCvDoc(deps: CvBuilderDeps, input: CvPromptInput, ctx: JobContext): Promise<RunResult<CvDoc>> {
  const prompt = buildCvPrompt(input)
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
    jsonSchema: CV_DOC_JSON_SCHEMA,
    output: CV_DOC_OUTPUT,
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

/** What a CV run brings back to the queue (the fields it produced; the rest stays). */
function patchOf(job: CvJob, doc: CvDoc, usage: ArtifactsPatch['usage']): ArtifactsPatch {
  return { cv: doc, profileVersion: job.profile.version, rules: job.rules.map((rule) => rule.id), usage, origin: 'generated' }
}

async function build(deps: CvBuilderDeps, work: Work, ctx: JobContext): Promise<JobResult> {
  const job = readJob(deps.db, work.ref)
  if (!job.ok) return job
  const sources = deps.sources()
  if (!sources.ok) return failed(sources.error.reason)
  const written = await writeCvDoc(deps, promptInput(job.value, sources.value), ctx)
  if (!written.ok) return written
  return { ok: true, output: { type: 'application', artifacts: patchOf(job.value, written.value, written.usage) } }
}

/** The handler of `cv` works: `createQueue({ handlers: { cv: createCvHandler(deps) } })`. */
export function createCvHandler(deps: CvBuilderDeps): JobHandler {
  return (work, ctx) => build(deps, work, ctx)
}
