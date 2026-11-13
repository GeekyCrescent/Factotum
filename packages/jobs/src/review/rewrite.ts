/**
 * The `rewrite` job of an APPLICATION (tasks R2; design D10 «La reescritura», «Los huecos sobreviven
 * a la reescritura»): the queue's handler for `kind: 'rewrite'` (G2a), injected into `createQueue`.
 *
 * WHAT IT DOES: reads the current version, the profile, the rules, the company, the opportunity and
 * the instruction (the last `instruction` event, `instructionEvent`'s shape); runs Claude with the
 * rewrite prompt; checks that every field kept its slots (`slotsPreserved`) and its form answers;
 * prints the CV again when the CV changed; and answers the new version with `origin: 'rewritten'`.
 * WRITING it is the queue's (`applicationReturned`): the guard of G4, the re-lint and T-A8.
 *
 * AN ANSWER THAT LOSES, FILLS OR ADDS A SLOT is out of the schema (B2): a failed run with the reason
 * `slots`, so it counts as an attempt (2 and 10 min), and the third is A4's failure — T-A9, back to
 * `rewriteFrom` with `rewrite-failed { instruction, reason: 'slots' }` (written by `returns.ts`).
 * Only «Remove the portfolio line» may remove `{portfolio}`: the work has no column for a mark, so
 * `allowDrop` is read from the instruction itself, which is that sentence or not.
 *
 * NEVER IN A REASON OR THE LOG: a word of the prompt, the answer or the instruction.
 */

import type { Logger, Timers } from '@factotum/core'

import type { JobHandler, JobResult } from '../ai/queue.ts'
import { writeSystemFile } from '../ai/prompts/fixed.ts'
import { buildRewritePrompt, REMOVE_PORTFOLIO_INSTRUCTION, REWRITE_JSON_SCHEMA, REWRITE_OUTPUT, type RewriteOutput, type RewritePromptInput } from '../ai/prompts/rewrite.ts'
import { runClaude } from '../ai/run.ts'
import { slotsPreserved, type SlotFields, type SlotName } from '../build/slots.ts'
import type { Db, Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { fail, ok, type Application, type Artifacts, type CvDoc, type Result } from '../types.ts'

/** The reason of an answer whose slots changed (D10: `rewrite-failed { reason: 'slots' }`). */
export const SLOTS_REASON = 'slots'
/** The reason of an answer with another number of form answers than it was given. */
export const FORM_REASON = 'form-answers'

/** D5 steps 5–7 for a CV that changed: lane 3's printer, injected. The paths are relative to `stateDir`. */
export type PrintFn = (input: {
  readonly applicationId: string
  /** The version the print belongs to (the current one + 1). */
  readonly version: number
  readonly cv: CvDoc
  readonly signal: AbortSignal
}) => Promise<Result<Pick<Artifacts, 'pdf' | 'png' | 'contactHash'>>>

export interface RewriteDeps {
  readonly db: Db
  readonly now: () => Date
  readonly timers: Timers
  /** `<stateDir>`: the master prompt file goes under `prompts/`. */
  readonly stateDir: string
  /** `<stateDir>/run`, existing: the CLI's empty cwd. */
  readonly runDir: string
  /** `claude.models.write`, the effort, and the `fake-claude` seam (tests only). */
  readonly claude: { readonly model: string; readonly effort: string | undefined; readonly bin?: string }
  /** `cv-maestro.md` and `guia-para-el-agente.md`, whole. */
  readonly readFixed: () => Result<{ readonly master: string; readonly guide: string }>
  readonly print: PrintFn
  readonly log?: Logger
}

/** What a rewrite reads, in one read of the store. */
interface Context {
  readonly app: Application
  readonly current: Artifacts
  readonly prompt: Omit<RewritePromptInput, 'master' | 'guide'>
  readonly profileVersion: number
  readonly ruleIds: readonly string[]
}

const failed = (reason: string): JobResult => ({ ok: false, kind: 'failed', reason })

/** The text of the last instruction given to the application itself (not to a follow-up). */
function lastInstruction(q: Queries, applicationId: string): string {
  const given = repo.eventsOf(q, applicationId).filter((e) => e.kind === 'instruction' && e.data.followupId === undefined)
  const text = given.at(-1)?.data.instruction
  return typeof text === 'string' ? text : ''
}

function contextOf(q: Queries, ref: string): Result<Context> {
  if (repo.getFollowup(q, ref) !== undefined) return fail('conflict', 'a follow-up rewrite is R2b')
  const app = repo.getApplication(q, ref)
  if (app === undefined) return fail('not-found', 'no such application')
  const current = repo.getArtifacts(q, app.id, app.version)
  if (current?.letter == null) return fail('conflict', 'no letter to rewrite')
  const profile = repo.latestProfileVersion(q)
  if (profile === undefined) return fail('conflict', 'no-profile')
  const company = repo.getCompany(q, app.companyId)
  const opportunity = repo.getOpportunity(q, app.opportunityId)
  if (company === undefined || opportunity === undefined) return fail('not-found', 'no company or opportunity')
  const rules = repo.listRules(q).filter((rule) => rule.enabled && (rule.scope === 'all' || rule.scope === app.channel))
  const instruction = lastInstruction(q, app.id)
  const allowDrop: readonly SlotName[] = instruction.trim() === REMOVE_PORTFOLIO_INSTRUCTION ? ['portfolio'] : []
  return ok({
    app,
    current,
    profileVersion: profile.version,
    ruleIds: rules.map((rule) => rule.id),
    prompt: {
      profile: profile.profile,
      rules: rules.map((rule) => rule.text),
      company: { name: company.name, sector: company.sector, location: company.location, record: repo.companyRecord(q, company.id) ?? '' },
      opportunity: { kind: opportunity.kind, title: opportunity.title, requirements: opportunity.requirements },
      current: { cv: current.cv, letter: current.letter, form: current.form, linkedin: current.linkedin },
      instruction,
      allowDrop,
    },
  })
}

/** The fields that carry slots, by name (D10: subject, body, each answer, the LinkedIn note). */
interface SlotTexts {
  readonly letter: { readonly subject: string | null; readonly body: string } | null
  readonly linkedin: string | null
  readonly form: readonly { readonly answer: string }[]
}

function slotFieldsOf(version: SlotTexts): SlotFields {
  const answers = Object.fromEntries(version.form.map((entry, i) => [`form.${i}`, entry.answer]))
  return { subject: version.letter?.subject ?? null, body: version.letter?.body ?? null, linkedin: version.linkedin, ...answers }
}

/** Why the answer cannot be the new version, or null. */
function refusal(context: Context, answer: RewriteOutput): string | null {
  if (answer.form.length !== context.current.form.length) return FORM_REASON
  const allowDrop = context.prompt.allowDrop
  return slotsPreserved(slotFieldsOf(context.current), slotFieldsOf(answer), { allowDrop }) ? null : SLOTS_REASON
}

const sameCv = (a: CvDoc | null, b: CvDoc | null): boolean => JSON.stringify(a) === JSON.stringify(b)

export function createRewriteHandler(deps: RewriteDeps): JobHandler {
  return async (work, { signal, timeoutMs }) => {
    const read = deps.db.read((q) => contextOf(q, work.ref))
    if (!read.ok) return failed(read.error.reason)
    const context = read.value
    const fixed = deps.readFixed()
    if (!fixed.ok) return failed(fixed.error.reason)
    const prompt = buildRewritePrompt({ ...context.prompt, ...fixed.value })
    const systemFile = writeSystemFile(deps.stateDir, prompt.system)
    if (!systemFile.ok) return failed(systemFile.error.reason)
    const ran = await runClaude({
      prompt: prompt.stdin,
      systemFile: systemFile.value,
      jsonSchema: REWRITE_JSON_SCHEMA,
      output: REWRITE_OUTPUT,
      model: deps.claude.model,
      effort: deps.claude.effort,
      cwd: deps.runDir,
      timers: deps.timers,
      now: deps.now,
      signal,
      timeoutMs,
      log: deps.log,
      ...(deps.claude.bin === undefined ? {} : { bin: deps.claude.bin }),
    })
    if (!ran.ok) return ran
    const refused = refusal(context, ran.value)
    if (refused !== null) return failed(refused)
    // A CV is made by its own generation: a rewrite never brings one where there was none.
    const cv = context.current.cv === null ? null : ran.value.cv
    let printed: Pick<Artifacts, 'pdf' | 'png' | 'contactHash'> | Record<string, never> = {}
    if (cv !== null && !sameCv(cv, context.current.cv)) {
      const print = await deps.print({ applicationId: context.app.id, version: context.app.version + 1, cv, signal })
      if (!print.ok) return failed(`the print failed: ${print.error.reason}`)
      printed = print.value
    }
    const form = context.current.form.map((entry, i) => {
      const answer = ran.value.form[i]?.answer ?? entry.answer
      return { ...entry, answer, ok: answer.trim() !== '' }
    })
    return {
      ok: true,
      output: {
        type: 'application',
        artifacts: {
          cv,
          letter: ran.value.letter,
          form,
          linkedin: ran.value.linkedin,
          ...printed,
          profileVersion: context.profileVersion,
          rules: context.ruleIds,
          usage: ran.usage,
          origin: 'rewritten',
        },
      },
    }
  }
}
