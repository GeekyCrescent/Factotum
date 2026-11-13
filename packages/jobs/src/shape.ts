/**
 * The limits, and the checks every boundary of this package shares (design D2, D6, D7, D13).
 *
 * THE FACADE TAKES `unknown` and asks a schema. A route hands the body over as it came, so the
 * `400` carries `{ field, reason }` straight from `shape`.
 *
 * REFUSED, NEVER CLIPPED: the owner can fix what he typed; clipping would lose the tail in silence.
 *
 * A REASON NEVER CARRIES A VALUE: only a path and a message of ours (zod 4 does not quote the input).
 */

import type { z } from 'zod'
import { fail, ok, type Result } from './types.ts'

/** design D3: an ad's text. */
export const MAX_REQUIREMENTS_CHARS = 16 * 1024
/** design D7, requirements crit. 17. */
export const MAX_RULE_CHARS = 300
/** v4 (B9): one line under the CV's contact. */
export const MAX_CV_AVAILABILITY_CHARS = 120
/** The free-text fields of the profile, which go to the prompts as they are. */
export const MAX_PROSE_CHARS = 4000
/** A one-line field: a name, a label, an address, a subject. */
export const MAX_LINE_CHARS = 200
/** design D6: a LinkedIn note. */
export const MAX_LINKEDIN_CHARS = 280
/** A follow-up template body (email, plain text). */
export const MAX_TEMPLATE_CHARS = 2000
export const MIN_BATCH_SIZE = 1
export const MAX_BATCH_SIZE = 20
/** Words of a list in the profile (stacks, red lines, confidential names). */
export const MAX_LIST_ITEMS = 50
export const MAX_GOALS = 10
export const MAX_ABSENCES = 20
export const MAX_ID_CHARS = 64
export const MAX_PATH_CHARS = 1024

/** A machine name as the hosts list carries it: no slash, no dot-dot. */
export const HOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/
/** An id we hand out or the owner names (a goal): lowercase, digits and dashes. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
/**
 * design D6, the rule of `to` (v5, X11): no brackets, braces or spaces, and a dotted domain. Nor
 * `, ; < > " ( )`: the mail package's `isOneRecipient` refuses them at send time (one bare address
 * only), so an address with one is never offered as sendable here to fail there.
 */
export const SENDABLE_ADDRESS = /^[^\s@[\]{},;<>"()]+@[^\s@[\]{},;<>"()]+\.[a-z]{2,}$/i
/** design D6, the placeholder rule: ANY bracket token, with no word list. */
export const BRACKET_TOKEN = /\[[^\]\n]{1,80}\]/
const DEBRIS_WORDS = /\b(?:TODO|TBD)\b/

/** `YYYY-MM-DD` that is also a day of the calendar: `2026-02-30` is not. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

const climbs = (value: string): boolean => value.split('/').includes('..')

export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') && !climbs(value) && !value.includes('\0')
}

/** Relative to `vault.root`, never out of it. A trailing slash names a folder. */
export function isRelativePath(value: string): boolean {
  return value.length > 0 && !value.startsWith('/') && !climbs(value) && !value.includes('\0')
}

export const isSendableAddress = (value: string): boolean => SENDABLE_ADDRESS.test(value)

/** A bracket token, `TODO` or `TBD`: something a human would have to fill. */
export const hasTemplateDebris = (value: string): boolean => BRACKET_TOKEN.test(value) || DEBRIS_WORDS.test(value)

/**
 * The parsed object WITHOUT keys whose value is `undefined`. JSON cannot carry one, but a caller in
 * process can, and `exactOptionalPropertyTypes` tells "absent" from "undefined" (CLAUDE.md §2).
 */
function present<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

/** Parse an owner's body with `schema`: `invalid` with the path of the first issue as `field`. */
export function shape<T>(schema: z.ZodType, raw: unknown): Result<T> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('invalid', 'the body must be a JSON object', 'body')
  }
  const parsed = schema.safeParse(raw)
  if (parsed.success) return ok(present(parsed.data as object) as T)
  const issue = parsed.error.issues[0]
  if (issue === undefined) return fail('invalid', 'invalid', 'body')
  const path = issue.code === 'unrecognized_keys' ? [...issue.path, issue.keys[0] ?? ''] : issue.path
  const field = path.length === 0 ? 'body' : path.map(String).join('.')
  const reason = issue.code === 'unrecognized_keys' ? 'is not a known field' : issue.message
  return fail('invalid', reason, field)
}
