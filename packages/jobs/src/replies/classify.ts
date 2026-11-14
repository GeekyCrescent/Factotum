/**
 * Classifying a matched reply (design D12 «Clasificar»; tasks Q3): `claude -p` on `models.classify`
 * (`haiku`), no tools, no system file, through the generation queue's `interactive` lane (D10: a
 * `classify` work, 60 s).
 *
 * THE CLOSED LIST: the candidates go under short ids (`a0`…); the answer's id is mapped back, and one
 * that is not on the list is DISCARDED (`applicationId: null`) — the class stays. A class out of the
 * list is outside the schema: a failed run, retried by the queue (2 and 10 min).
 *
 * THE BODY NEVER TOUCHES DISK. The `work` row carries only the mail's key (`ref = UIDVALIDITY:UID`);
 * sender, subject and body wait IN MEMORY in the classifier, keyed by that ref. A work whose reply is
 * not in memory (the daemon restarted) ends `done` with nothing applied: the mail is not in
 * `mail_seen`, so the next read finds it again and submits it anew.
 *
 * A LIMIT OR A LOGGED-OUT CLI is the queue's (D10): the run comes back `kind: 'limit' | 'auth'`, the
 * queue pauses with no attempt counted and requeues the work, and the reply stays in memory for the
 * run after the pause. The reader skips a mail whose `classify` work is still queued or running.
 *
 * NOTHING HERE LOGS a body, a subject, an address or the summary.
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { JobContext, JobHandler, Queue, Work } from '../ai/queue.ts'
import { buildClassifyPrompt, CLASSIFY_JSON_SCHEMA, classifySchema, shortId, type ClassifyOutput } from '../ai/prompts/classify.ts'
import { runClaude, type RunFailure, type RunUsage } from '../ai/run.ts'
import type { FixedRunDeps } from '../build/cv.ts'
import type { Queries } from '../store/db.ts'
import { getApplication, getCompany, getOpportunity } from '../store/repo.ts'
import type { Result } from '../types.ts'
import { ok } from '../types.ts'
import type { ReplyClass } from './match.ts'
import type { ReadReply } from './read.ts'

/** The state folder, the clocks, the log and `{ model: models.classify, effort, bin }`. */
export type ClassifyDeps = FixedRunDeps

export interface ClassifyCandidate {
  readonly applicationId: string
  readonly company: string
  /** The opportunity's title. */
  readonly role: string
  /** ISO, of its `initial` row; null when it has none. */
  readonly sentAt: string | null
}

export interface ClassifyInput {
  readonly from: string
  readonly subject: string
  /** ≤ MAX_BODY_CHARS (the prompt cuts it again). */
  readonly body: string
  /** In this order they become `a0`, `a1`… */
  readonly candidates: readonly ClassifyCandidate[]
}

export interface ClassifyVerdict {
  readonly class: ReplyClass
  /** The candidate Claude named, or null (none named, or an id off the list). */
  readonly applicationId: string | null
  /** ≤ 160: for the event and the screen; never a push nor a log. */
  readonly summary: string
}

export type ClassifyResult = { readonly ok: true; readonly verdict: ClassifyVerdict; readonly usage: RunUsage } | RunFailure

/** The answer, with its short id mapped back to an application (or discarded). Pure. */
export function verdictOf(output: ClassifyOutput, candidates: readonly ClassifyCandidate[]): ClassifyVerdict {
  const index = candidates.findIndex((_c, i) => shortId(i) === output.application)
  return { class: output.class, applicationId: index === -1 ? null : (candidates[index]?.applicationId ?? null), summary: output.summary }
}

/** One run of Claude for one reply. Never throws; a limit or a logged-out CLI comes back as such. */
export async function classifyReply(deps: ClassifyDeps, input: ClassifyInput, ctx: JobContext): Promise<ClassifyResult> {
  if (input.candidates.length === 0) return { ok: false, kind: 'failed', reason: 'no candidate application to classify against' }
  const cwd = join(deps.stateDir, 'run')
  try {
    mkdirSync(cwd, { recursive: true, mode: 0o700 })
  } catch {
    return { ok: false, kind: 'failed', reason: 'the run folder could not be made' }
  }
  const prompt = buildClassifyPrompt({
    from: input.from,
    subject: input.subject,
    body: input.body,
    candidates: input.candidates.map((c, i) => ({ id: shortId(i), company: c.company, role: c.role, sentAt: c.sentAt })),
  })
  const run = await runClaude({
    prompt,
    jsonSchema: CLASSIFY_JSON_SCHEMA,
    output: classifySchema,
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
  return run.ok ? { ok: true, verdict: verdictOf(run.value, input.candidates), usage: run.usage } : run
}

/**
 * What goes to Claude for a matched reply, read from the store: the thread's one application, or the
 * candidates of rules 2–3 in their order (an application that is gone is left out). Undefined for an
 * unmatched reply: it never goes to Claude (D12 rule 4).
 */
export function classifyInputOf(q: Queries, reply: ReadReply): ClassifyInput | undefined {
  const ids = reply.match.kind === 'thread' ? [reply.match.applicationId] : reply.match.kind === 'candidates' ? reply.match.applicationIds : undefined
  if (ids === undefined) return undefined
  const candidates = ids.flatMap((id): ClassifyCandidate[] => {
    const app = getApplication(q, id)
    if (app === undefined) return []
    const company = getCompany(q, app.companyId)?.name ?? ''
    const role = getOpportunity(q, app.opportunityId)?.title ?? ''
    return [{ applicationId: app.id, company, role, sentAt: app.sends.find((s) => s.kind === 'initial')?.at ?? null }]
  })
  return { from: reply.from, subject: reply.subject, body: reply.body, candidates }
}

/** A reply waiting for its classification: the mail as read, and what goes to Claude. */
export interface ReplyJob {
  readonly reply: ReadReply
  readonly input: ClassifyInput
}

export interface ClassifierDeps extends ClassifyDeps {
  /** Q4: applies the verdict (events, state, `mail_seen`) in the queue's `tx` of the return. */
  readonly apply: (q: Queries, job: ReplyJob, verdict: ClassifyVerdict, now: Date) => Result<void>
}

export interface Classifier {
  /** `handlers.classify` of the queue. */
  readonly handler: JobHandler
  /** Keeps `job` in memory and enqueues its `classify` work (ref = the mail's key), in the caller's `tx`; pump after. */
  readonly submit: (q: Queries, enqueue: Queue['enqueue'], job: ReplyJob) => Result<Work>
}

const NOTHING_TO_APPLY = { ok: true, output: { type: 'apply', apply: () => ok(undefined) } } as const

export function createClassifier(deps: ClassifierDeps): Classifier {
  const waiting = new Map<string, ReplyJob>()

  const handler: JobHandler = async (work, ctx) => {
    const job = waiting.get(work.ref)
    if (job === undefined) return NOTHING_TO_APPLY
    const result = await classifyReply(deps, job.input, ctx)
    if (!result.ok) return result
    waiting.delete(work.ref)
    return { ok: true, output: { type: 'apply', apply: (q, now) => deps.apply(q, job, result.verdict, now) } }
  }

  const submit = (q: Queries, enqueue: Queue['enqueue'], job: ReplyJob): Result<Work> => {
    const work = enqueue(q, { kind: 'classify', ref: job.reply.key, lane: 'interactive' })
    if (work.ok) waiting.set(job.reply.key, job)
    return work
  }

  return { handler, submit }
}
