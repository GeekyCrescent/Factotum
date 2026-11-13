/**
 * The verifier (design D6 «El verificador»; tasks L3): `claude -p` with `cv-maestro` in front and the
 * CV or the letter by stdin, answering `{ unsupported: { where, claim, why }[] }` (≤ 10). Each one is an
 * `unsupported-claim` WARNING THAT BLOCKS.
 *
 * IT RUNS ON EVERY CV AND EVERY REWRITE — NEVER ON THE SEED'S TEXTS: they passed the check of
 * 2026-11-10 (package 03, header). A version whose `origin` is `seed`, or one with nothing to read,
 * comes back clean without a run of Claude.
 *
 * «I CHECKED IT» (`checkIt`) is the owner's way out of `unsupported-claim` and of `external-link`
 * (D6 «Cómo se resuelve»): every warning of that code gets `overridden`, the application is moved as a
 * re-lint would move it (`ready` once nothing blocks and the PDF is there), and the event is
 * `override { code }` — THE CODE, NEVER THE CLAIM'S TEXT.
 */

import type { JobContext } from '../ai/queue.ts'
import { buildVerifyPrompt } from '../ai/prompts/verify.ts'
import { VERIFY_JSON_SCHEMA, verifySchema, type VerifyOutput } from '../ai/schemas.ts'
import { appTransition } from '../state.ts'
import type { Queries } from '../store/db.ts'
import { getApplication, getArtifacts, saveApplication } from '../store/repo.ts'
import { fail, type Application, type Result, type Warning, type WarningCode } from '../types.ts'
import { runFixed, type CvSources, type FixedRunDeps, type VerifyFn, type VerifyOutcome, type VerifyTarget } from './cv.ts'
import { failed } from './print.ts'

export interface VerifierDeps extends FixedRunDeps {
  /** The master CV and the guide: the same reader as the builder's. */
  readonly sources: () => Result<Pick<CvSources, 'master' | 'guide'>>
}

const CLEAN: VerifyOutcome = { ok: true, warnings: [], usage: null }

/** One `unsupported-claim` per claim, blocking, `detail` = «claim — why» (≤ 403 characters). Pure. */
export function unsupportedWarnings(unsupported: VerifyOutput['unsupported']): readonly Warning[] {
  return unsupported.map((u) => ({ code: 'unsupported-claim', where: u.where, detail: `${u.claim} — ${u.why}`, blocks: true, overridden: null }))
}

async function check(deps: VerifierDeps, target: VerifyTarget, ctx: JobContext): Promise<VerifyOutcome> {
  if (target.origin === 'seed' || (target.cv === null && target.letter === null)) return CLEAN
  const sources = deps.sources()
  if (!sources.ok) return failed(sources.error.reason)
  const prompt = buildVerifyPrompt({ ...sources.value, cv: target.cv, letter: target.letter })
  const run = await runFixed(deps, prompt, { json: VERIFY_JSON_SCHEMA, output: verifySchema }, ctx)
  return run.ok ? { ok: true, warnings: unsupportedWarnings(run.value.unsupported), usage: run.usage } : run
}

/** The verifier the builder (and the rewrite) is given: `createCvHandler({ …, verify: createVerifier(deps) })`. */
export function createVerifier(deps: VerifierDeps): VerifyFn {
  return (target, ctx) => check(deps, target, ctx)
}

// ── «I checked it» ───────────────────────────────────────────────────────────────────────────────

/**
 * The codes «I checked it» resolves (D6 «Cómo se resuelve cada bloqueo»), and `ad-closed`, which the
 * card offers beside «Skip it» (R3's decision; revalidate.ts: «the owner may override it»).
 */
export const CHECKABLE: readonly WarningCode[] = ['unsupported-claim', 'external-link', 'ad-closed']

/** The reason of an «I checked it» with no open warning of its codes. */
export const NOTHING_TO_CHECK = 'nothing-to-check'

const REVIEWED: ReadonlySet<Application['state']> = new Set<Application['state']>(['in-review', 'ready'])

export interface CheckIt {
  readonly applicationId: string
  readonly codes: readonly WarningCode[]
  /** The caller's `stat` of the current PDF (as the linter's `pdfExists`). */
  readonly pdfExists: (path: string) => boolean
}

/**
 * «I checked it», in the caller's `tx` — THE ONE IMPLEMENTATION (the review's `override` calls it):
 * every open warning of `codes` overridden, the state re-decided (T-A5/T-A6), `override { codes }`.
 * A code it does not resolve is `invalid`; no open warning of those codes is `conflict nothing-to-check`.
 */
export function checkIt(q: Queries, input: CheckIt, now: Date): Result<void> {
  if (input.codes.length === 0 || input.codes.some((code) => !CHECKABLE.includes(code))) {
    return fail('invalid', `only ${CHECKABLE.join(', ')} take «I checked it»`, 'warningCodes')
  }
  const app = getApplication(q, input.applicationId)
  if (app === undefined) return fail('not-found', 'no such application')
  if (!REVIEWED.has(app.state)) return fail('conflict', `an application ${app.state} is not in review`)
  const open = (w: Warning): boolean => input.codes.includes(w.code) && w.overridden === null
  if (!app.warnings.some(open)) return fail('conflict', NOTHING_TO_CHECK)
  const at = now.toISOString()
  const warnings = app.warnings.map((w) => (open(w) ? { ...w, overridden: { at } } : w))
  const pdf = getArtifacts(q, app.id, app.version)?.pdf ?? null
  const moved = appTransition(app, { type: 'relint', pdfExists: pdf !== null && input.pdfExists(pdf), warnings }, now)
  if (!moved.ok) return moved
  return saveApplication(q, { ...moved.value, updatedAt: at }, { kind: 'override', data: { codes: [...input.codes] } }, now)
}
