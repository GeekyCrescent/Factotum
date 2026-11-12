/**
 * Limits, and the shaping of everything that arrives from outside (design D2, «Límites»).
 *
 * EVERY INPUT ARRIVES AS `unknown` and is shaped here before an op sees it, so the `400` with its
 * field comes from one place — the rule of `packages/tasks/src/shape.ts`.
 */

import { z } from 'zod'
import { STAGE_IDS, type StageId } from './types.ts'

export const NAME_MAX_CHARS = 80
export const COMMENT_MAX_CHARS = 4_000
export const NOTE_MAX_CHARS = 200_000
export const SUMMARY_MAX_CHARS = 600
export const INPUTS_MAX = 60
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024
/** Per `GET docs/:stage` answer; our own, not the kernel's `MAX_BODY_BYTES`. */
export const DOC_MAX_BYTES = 1024 * 1024
/** The sweep marks a run without a session `stalled` after this — never abandoned (criterion 18). */
export const STARTING_ABANDON_MS = 10 * 60_000
/** The screen offers «Abandon» on a run without a session after this (criterion 18). */
export const STARTING_OFFER_MS = 2 * 60_000
export const SWEEP_EVERY_MS = 60_000
export const GUARD_MAX_FILES = 20_000
export const GUARD_MAX_MS = 60_000
const MAX_PROJECTS = 500
const MAX_FILES = 40
const MAX_PATH_CHARS = 4_096
const UPLOAD_NAME_MAX_CHARS = 200

/** A COPY of `SITE_ID_PATTERN` (`modules/sessions/config.ts`): this package cannot import a module. */
export const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
/** A COPY of the shape `uuidv7` produces. */
export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** A project folder under `projectsDir`, and its hub's name: never a `/`, never a `..`. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
/** A plain file name: letters, digits, space and `._-()`; never a leading dot. */
const UPLOAD_NAME = /^[A-Za-z0-9 _()-][A-Za-z0-9 ._()-]*$/

export type Shaped<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly field: string; readonly reason: string }

export type ProjectChoice =
  | { readonly kind: 'existing'; readonly slug: string }
  | {
      readonly kind: 'new'
      readonly slug: string
      readonly title: string
      readonly client: string
      readonly summary: string
      readonly difficulty: 'low' | 'medium' | 'high'
      readonly due?: string
    }

export interface CreateInput {
  readonly name: string
  readonly client: string
  readonly project: ProjectChoice
}

export interface DecisionInput {
  readonly step: StageId
  readonly action: 'approve' | 'choose' | 'redo'
  readonly optionId?: string
  readonly comment?: string
}

export interface SubmitInput {
  readonly runId: string
  readonly files: readonly string[]
  readonly summary: string
  readonly options?: readonly { readonly id: string; readonly title: string; readonly blurb: string; readonly url?: string }[]
  readonly previewUrl?: string
  readonly prodUrl?: string
}

/** `YYYY-MM-DD` that is also a day of the calendar: `2026-02-30` is not. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

const text = (max: number) => z.string().trim().min(1, 'must not be empty').max(max, `at most ${max} characters`)
const slug = z.string().regex(SLUG_PATTERN, 'a slug is lower case letters, digits and dashes')
const siteId = z.string().regex(SITE_ID_PATTERN, 'a siteId must match /^[a-z0-9][a-z0-9-]*$/, up to 64 characters')

const createSchema = z.strictObject({
  name: text(NAME_MAX_CHARS),
  client: text(NAME_MAX_CHARS),
  project: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('existing'), slug }),
    z.strictObject({
      kind: z.literal('new'),
      slug,
      title: text(NAME_MAX_CHARS * 2),
      client: text(NAME_MAX_CHARS),
      summary: text(COMMENT_MAX_CHARS),
      difficulty: z.enum(['low', 'medium', 'high'], { error: 'difficulty is low, medium or high' }),
      due: z.string().refine(isCalendarDate, 'due is YYYY-MM-DD, a day of the calendar').optional(),
    }),
  ]),
})

const runSchema = z.strictObject({ kind: z.enum(STAGE_IDS, { error: 'kind is a stage' }) })

const decisionSchema = z.strictObject({
  step: z.enum(STAGE_IDS, { error: 'step is a stage' }),
  action: z.enum(['approve', 'choose', 'redo'], { error: 'action is approve, choose or redo' }),
  optionId: z.string().min(1).max(64).optional(),
  comment: text(COMMENT_MAX_CHARS).optional(),
})

const noteSchema = z.strictObject({ text: text(NOTE_MAX_CHARS) })

const siteMatchSchema = z.strictObject({
  projects: z.array(z.strictObject({ id: siteId, path: z.string().min(1).max(MAX_PATH_CHARS) })).max(MAX_PROJECTS),
})

const siteSchema = z.union([z.strictObject({ siteId }), z.strictObject({ refused: text(COMMENT_MAX_CHARS) })], {
  error: 'a site is { siteId } or { refused }',
})

const linkSchema = z.strictObject({ sessionId: z.string().regex(SESSION_ID_PATTERN, 'a session id is a uuidv7') })
const abandonSchema = z.strictObject({ reason: text(COMMENT_MAX_CHARS).optional() })

const submitSchema = z.strictObject({
  runId: z.string().min(1).max(64),
  files: z.array(z.string().min(1).max(MAX_PATH_CHARS)).min(1, 'name at least one file').max(MAX_FILES),
  summary: text(SUMMARY_MAX_CHARS),
  options: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'an option id is lower case letters, digits and dashes'),
        title: text(NAME_MAX_CHARS),
        blurb: text(SUMMARY_MAX_CHARS),
        url: z.string().max(MAX_PATH_CHARS).optional(),
      }),
    )
    .max(10)
    .optional(),
  previewUrl: z.string().max(MAX_PATH_CHARS).optional(),
  prodUrl: z.string().max(MAX_PATH_CHARS).optional(),
})

/**
 * The parsed object WITHOUT keys whose value is `undefined`: `exactOptionalPropertyTypes` tells
 * "absent" from "undefined" (CLAUDE.md §2).
 */
function present<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

function shape<T>(schema: z.ZodType, raw: unknown): Shaped<T> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, field: 'body', reason: 'the body must be a JSON object' }
  }
  const parsed = schema.safeParse(raw)
  if (parsed.success) return { ok: true, value: deepPresent(parsed.data) as T }
  const issue = parsed.error.issues[0]
  if (issue === undefined) return { ok: false, field: 'body', reason: 'invalid' }
  const path = issue.code === 'unrecognized_keys' ? [...issue.path, issue.keys[0] ?? ''] : issue.path
  const field = path.length === 0 ? 'body' : path.map(String).join('.')
  const reason = issue.code === 'unrecognized_keys' ? 'is not a field this takes' : issue.message
  return { ok: false, field, reason }
}

function deepPresent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepPresent)
  if (typeof value === 'object' && value !== null) {
    return present(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepPresent(v)])))
  }
  return value
}

export const parseCreate = (raw: unknown): Shaped<CreateInput> => shape(createSchema, raw)
export const parseRun = (raw: unknown): Shaped<{ readonly kind: StageId }> => shape(runSchema, raw)
export const parseDecision = (raw: unknown): Shaped<DecisionInput> => shape(decisionSchema, raw)
export const parseNote = (raw: unknown): Shaped<{ readonly text: string }> => shape(noteSchema, raw)
export const parseSiteMatch = (raw: unknown): Shaped<{ readonly projects: readonly { readonly id: string; readonly path: string }[] }> =>
  shape(siteMatchSchema, raw)
export const parseSite = (raw: unknown): Shaped<{ readonly siteId: string } | { readonly refused: string }> => shape(siteSchema, raw)
export const parseLink = (raw: unknown): Shaped<{ readonly sessionId: string }> => shape(linkSchema, raw)
/** No body is an abandon without a reason. */
export const parseAbandon = (raw: unknown): Shaped<{ readonly reason?: string }> => shape(abandonSchema, raw ?? {})
export const parseSubmit = (raw: unknown): Shaped<SubmitInput> => shape(submitSchema, raw)

/** `?name=` of an upload: a plain file name, or a `400`. */
export function uploadName(raw: string | undefined): Shaped<string> {
  const field = 'name'
  if (raw === undefined || raw.trim() === '') return { ok: false, field, reason: 'an upload needs ?name=' }
  const name = raw.trim()
  if (name.length > UPLOAD_NAME_MAX_CHARS) return { ok: false, field, reason: `at most ${UPLOAD_NAME_MAX_CHARS} characters` }
  if (!UPLOAD_NAME.test(name) || name.includes('..')) return { ok: false, field, reason: 'a plain file name: letters, digits, space and ._-()' }
  return { ok: true, value: name }
}
