/**
 * The owner's profile (design D7): free text for the prompts, structure only where code decides.
 *
 * SAVED AS VERSIONS, NEVER REWRITTEN: every save is a new row of `profile_versions`, and what was
 * scored or generated keeps the version it was made with (requirements crit. 16).
 *
 * THE SEED IS A DATA FILE, `assets/profile-seed.json` — the work rights, the goals, the red lines and
 * the owner's answers of 13 Nov. It is read ONCE, when `profile_versions` is empty, and stored as
 * version 1; from then on the profile is the owner's. No `.ts` here carries those values (B7 greps).
 *
 * `afterSave` RUNS INSIDE THE SAME `tx` as the new version and answers with a `Result`: a `!ok` rolls
 * the version back. Here it is a no-op by default; `build/relint.ts` (`saveProfileRelinting`, L4) passes `relintUnsent`.
 */

import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Db, Queries } from './store/db.ts'
import { insertProfileVersion, latestProfileVersion } from './store/repo.ts'
import {
  BRACKET_TOKEN,
  hasTemplateDebris,
  ID_PATTERN,
  isCalendarDate,
  MAX_ABSENCES,
  MAX_BATCH_SIZE,
  MAX_CV_AVAILABILITY_CHARS,
  MAX_GOALS,
  MAX_LINE_CHARS,
  MAX_LINKEDIN_CHARS,
  MAX_LIST_ITEMS,
  MAX_PROSE_CHARS,
  MAX_TEMPLATE_CHARS,
  MIN_BATCH_SIZE,
  shape,
} from './shape.ts'
import { fail, ok, SCORE_KEYS, SOURCE_IDS, type Profile, type ProfileVersion, type Result } from './types.ts'

const SEED_FILE = new URL('../assets/profile-seed.json', import.meta.url)

/** design D7: the only fields a follow-up template may carry; `{signature}` never in the LinkedIn note. */
const TEMPLATE_FIELDS = ['greetingName', 'role', 'company', 'sentDate', 'signature'] as const
const LINKEDIN_FIELDS = TEMPLATE_FIELDS.filter((field) => field !== 'signature')
const BRACE_TOKEN = /\{([^{}\n]{0,40})\}/g
const WEIGHT_TOTAL = 100

const line = z.string().trim().max(MAX_LINE_CHARS)
const prose = z.string().max(MAX_PROSE_CHARS)
const words = z.array(z.string().trim().min(1).max(MAX_LINE_CHARS)).max(MAX_LIST_ITEMS)
const day = z.string().refine(isCalendarDate, 'a day is YYYY-MM-DD')

/** A template whose every hole the module fills: no other `{…}`, no `[…]`, no TODO or TBD. */
function template(max: number, allowed: readonly string[]) {
  return z
    .string()
    .max(max)
    .superRefine((value, ctx) => {
      const unknown = [...value.matchAll(BRACE_TOKEN)].some((match) => !allowed.includes(match[1] ?? ''))
      if (unknown) ctx.addIssue({ code: 'custom', message: `a template only takes ${allowed.map((f) => `{${f}}`).join(', ')}` })
      else if (BRACKET_TOKEN.test(value) || hasTemplateDebris(value)) {
        ctx.addIssue({ code: 'custom', message: 'a template cannot carry a [bracket], TODO or TBD a human would have to fill' })
      }
    })
}

const weights = z
  .strictObject(Object.fromEntries(SCORE_KEYS.map((key) => [key, z.number().int().min(0).max(WEIGHT_TOTAL)])) as Record<(typeof SCORE_KEYS)[number], z.ZodNumber>)
  .refine((w) => Object.values(w).reduce((a, b) => a + b, 0) === WEIGHT_TOTAL, `the weights add up to ${WEIGHT_TOTAL}`)

export const profileSchema = z.strictObject({
  identity: z.strictObject({
    name: line.min(1),
    email: line,
    phone: line,
    linkedin: line,
    city: line,
    suburb: line,
    timezone: line,
    portfolioUrl: line,
    cvAvailabilityLine: z
      .string()
      .max(MAX_CV_AVAILABILITY_CHARS, `the CV availability line is at most ${MAX_CV_AVAILABILITY_CHARS} characters`)
      .refine((value) => !/[\r\n]/.test(value), 'the CV availability line is one line'),
  }),
  situation: prose,
  availability: prose,
  absences: z
    .array(
      z
        .strictObject({ from: day, to: day, label: line })
        .refine((absence) => absence.from <= absence.to, 'an absence ends on or after the day it starts'),
    )
    .max(MAX_ABSENCES),
  goals: z
    .array(
      z.strictObject({
        id: z.string().regex(ID_PATTERN, 'a goal id is lowercase letters, digits and dashes'),
        label: line.min(1),
        enabled: z.boolean(),
        text: prose,
        payFloor: z
          .strictObject({ amount: z.number().positive(), currency: z.string().regex(/^[A-Z]{3}$/, 'a currency is ISO 4217, like AUD'), per: z.enum(['hour', 'year']) })
          .nullable(),
        sources: z.array(z.enum(SOURCE_IDS, { error: 'not a scout source of D14' })).max(SOURCE_IDS.length),
      }),
    )
    .max(MAX_GOALS),
  level: prose,
  redLines: z.strictObject({ text: prose, titleWords: words, requirementWords: words, unpaid: z.boolean(), equityOnly: z.boolean() }),
  preferences: z.strictObject({ text: prose, rateExpectation: line }),
  forbiddenStacks: words,
  confidential: words,
  batchSize: z.number().int().min(MIN_BATCH_SIZE).max(MAX_BATCH_SIZE),
  weights,
  followup: z.strictObject({
    subject: template(MAX_LINE_CHARS, TEMPLATE_FIELDS),
    first: template(MAX_TEMPLATE_CHARS, TEMPLATE_FIELDS),
    second: template(MAX_TEMPLATE_CHARS, TEMPLATE_FIELDS),
    linkedin: template(MAX_LINKEDIN_CHARS, LINKEDIN_FIELDS),
  }),
})

/** The owner's body (or the seed): `invalid` with the field of the first issue. */
export const parseProfile = (raw: unknown): Result<Profile> => shape<Profile>(profileSchema, raw)

/** Reads and checks the seed file; a bad one is the package's fault, so `module-error`. */
export function loadProfileSeed(read: () => string = () => readFileSync(SEED_FILE, 'utf8')): Result<Profile> {
  let raw: unknown
  try {
    raw = JSON.parse(read())
  } catch (error) {
    return fail('module-error', `profile-seed.json does not read: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = parseProfile(raw)
  return parsed.ok ? parsed : fail('module-error', `profile-seed.json: ${parsed.error.field ?? 'body'}: ${parsed.error.reason}`)
}

export const currentProfile = (q: Queries): ProfileVersion | undefined => latestProfileVersion(q)

export interface ProfileContext {
  readonly now: () => Date
  /** The seam for the seed file. */
  readonly readSeed?: () => string
}

/** The current profile; on an empty store, the seed becomes version 1 (and only then is it read). */
export function ensureProfile(db: Db, ctx: ProfileContext): Result<ProfileVersion> {
  return db.tx((q) => {
    const current = latestProfileVersion(q)
    if (current !== undefined) return ok(current)
    const seed = loadProfileSeed(ctx.readSeed)
    if (!seed.ok) return seed
    const now = ctx.now()
    const saved: ProfileVersion = { version: 1, createdAt: now.toISOString(), profile: seed.value }
    insertProfileVersion(q, saved, { kind: 'profile-saved', data: { seeded: true } }, now)
    return ok(saved)
  })
}

/** Runs in the `tx` that saved; a `!ok` rolls the save back. */
export type AfterSave<S, T> = (q: Queries, saved: S) => Result<T>

export interface Saved<S, T> {
  readonly saved: S
  /** What `afterSave` answered (L4: how many were re-linted). */
  readonly hook: T
}

export function saveProfile<T = undefined>(
  db: Db,
  input: unknown,
  ctx: { readonly now: () => Date; readonly afterSave?: AfterSave<ProfileVersion, T> },
): Result<Saved<ProfileVersion, T>> {
  const parsed = parseProfile(input)
  if (!parsed.ok) return parsed
  return db.tx((q) => {
    const now = ctx.now()
    const saved: ProfileVersion = { version: (latestProfileVersion(q)?.version ?? 0) + 1, createdAt: now.toISOString(), profile: parsed.value }
    insertProfileVersion(q, saved, { kind: 'profile-saved' }, now)
    if (ctx.afterSave === undefined) return ok({ saved, hook: undefined as T })
    const hook = ctx.afterSave(q, saved)
    return hook.ok ? ok({ saved, hook: hook.value }) : hook
  })
}
