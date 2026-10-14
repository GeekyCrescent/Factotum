/**
 * What the owner may write into a card, and the limits of criterion 10 (spec 2026-10-14, design D2).
 *
 * THE FACADE TAKES `unknown` and asks this file. A route hands the body over as it came, so the
 * one place that knows a limit is here, and the `400` carries `{ field, reason }` straight from it.
 *
 * REFUSED, NEVER CLIPPED. Unlike the agent's questions (`ask_owner`), a card is typed by the owner
 * in a form that already knows the limits: a title of 201 characters is a bug or a paste, and the
 * owner can fix it. Clipping would lose the tail without a word.
 *
 * `strictObject` everywhere: zod drops an unknown key in silence (CLAUDE.md §2), and a mistyped
 * `"lables"` would save the card without its labels.
 *
 * A REASON NEVER CARRIES A VALUE: only zod's message, which in zod 4 does not quote the input. The
 * log can carry a reason, and the log never carries a title (criterion 41).
 */

import { z } from 'zod'
import { CYCLE_ID_PATTERN } from './cycle.ts'
import type { CloseInput, LinkInput, MoveInput, NewTask, TaskPatch } from './types.ts'

export const MAX_TITLE_CHARS = 200
export const MAX_NOTES_CHARS = 4000
export const MAX_AREA_CHARS = 40
export const MAX_LABELS = 10
export const MAX_LABEL_CHARS = 30
export const MAX_SUBTASKS = 30
export const MAX_SUBTASK_CHARS = 200
/** Subtask ids are plumbing; bounded like everything that comes from outside. */
export const MAX_ID_CHARS = 64

/** A COPY of `SITE_ID_PATTERN` (`modules/sessions/config.ts`): this package cannot import a module. */
export const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
/** A machine name as the hosts list carries it. It becomes `/h/<host>/` in a URL: no slash, no dot-dot. */
export const HOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/
/** A COPY of the shape `uuidv7` produces (`isSessionId` in `@factotum/sessions`, not exported). */
export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type Shaped<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly field: string; readonly reason: string }

/** `YYYY-MM-DD` that is also a day of the calendar: `2026-02-30` is not. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

const title = z.string().trim().min(1).max(MAX_TITLE_CHARS)
const notes = z.string().max(MAX_NOTES_CHARS)
const area = z.string().trim().min(1).max(MAX_AREA_CHARS)
const hostName = z.string().regex(HOST_NAME_PATTERN, 'a host is a machine name, like omarchy')
const project = z.strictObject({
  host: hostName.nullable(),
  siteId: z.string().regex(SITE_ID_PATTERN, 'a siteId must match /^[a-z0-9][a-z0-9-]*$/, up to 64 characters'),
})
const priority = z.number().int().min(0).max(4)
const estimate = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(8)], {
  error: 'an estimate is 1, 2, 3, 5 or 8',
})
const labels = z.array(z.string().trim().min(1).max(MAX_LABEL_CHARS)).max(MAX_LABELS)
const due = z.string().refine(isCalendarDate, 'a due date is a real day, YYYY-MM-DD')
const remindAt = z.iso.datetime({ offset: true, error: 'a reminder is an ISO date-time with its offset' })
const subtasks = z
  .array(
    z.strictObject({
      id: z.string().min(1).max(MAX_ID_CHARS).optional(),
      text: z.string().trim().min(1).max(MAX_SUBTASK_CHARS),
      done: z.boolean().optional(),
    }),
  )
  .max(MAX_SUBTASKS)

const editable = {
  notes: notes.optional(),
  area: area.nullable().optional(),
  project: project.nullable().optional(),
  priority: priority.optional(),
  labels: labels.optional(),
  estimate: estimate.nullable().optional(),
  due: due.nullable().optional(),
  remindAt: remindAt.nullable().optional(),
  subtasks: subtasks.optional(),
}

const newTaskSchema = z.strictObject({ title, status: z.enum(['backlog', 'todo']), ...editable })
const patchSchema = z.strictObject({ title: title.optional(), ...editable })
/** Triage is not a column: a card gets there only from the AI, and leaves it only by `accept`. */
const moveSchema = z.strictObject({
  status: z.enum(['backlog', 'todo', 'in_progress', 'blocked', 'done', 'canceled']),
  before: z.string().min(1).max(MAX_ID_CHARS).optional(),
  after: z.string().min(1).max(MAX_ID_CHARS).optional(),
})
const acceptSchema = z.strictObject({ to: z.enum(['backlog', 'todo']) })
const closeSchema = z.strictObject({
  from: z.string().regex(CYCLE_ID_PATTERN, 'a cycle is YYYY-Www, the week with two digits'),
  moves: z.record(z.string().min(1).max(MAX_ID_CHARS), z.enum(['next', 'backlog'])).optional(),
})
const linkSchema = z.strictObject({
  host: hostName.nullable(),
  sessionId: z.string().regex(SESSION_ID_PATTERN, 'a session id is a uuidv7'),
})

/**
 * The parsed object WITHOUT keys whose value is `undefined`. JSON cannot carry one, but a caller in
 * process can, and `exactOptionalPropertyTypes` tells "absent" from "undefined" (CLAUDE.md §2).
 */
function present<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

function shape<T>(schema: z.ZodType, raw: unknown): Shaped<T> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, field: 'body', reason: 'the body must be a JSON object' }
  }
  const parsed = schema.safeParse(raw)
  if (parsed.success) return { ok: true, value: present(parsed.data as object) as T }
  const issue = parsed.error.issues[0]
  if (issue === undefined) return { ok: false, field: 'body', reason: 'invalid' }
  const path = issue.code === 'unrecognized_keys' ? [...issue.path, issue.keys[0] ?? ''] : issue.path
  const field = path.length === 0 ? 'body' : path.map(String).join('.')
  const reason = issue.code === 'unrecognized_keys' ? 'is not a field of a card' : issue.message
  return { ok: false, field, reason }
}

/** A capture: free text, and the projects the client could read for the closed list (S12). */
export const MAX_CAPTURE_CHARS = 1000
export const MAX_CAPTURE_PROJECTS = 100
export const MAX_PROJECT_NAME_CHARS = 100
const captureSchema = z.strictObject({
  text: z.string().trim().min(1).max(MAX_CAPTURE_CHARS),
  projects: z
    .array(
      z.strictObject({
        host: hostName.nullable(),
        siteId: project.shape.siteId,
        name: z.string().trim().min(1).max(MAX_PROJECT_NAME_CHARS),
      }),
    )
    .max(MAX_CAPTURE_PROJECTS)
    .optional(),
})

export interface CaptureRequest {
  readonly text: string
  readonly projects?: readonly { readonly host: string | null; readonly siteId: string; readonly name: string }[]
}

export const parseCapture = (raw: unknown): Shaped<CaptureRequest> => shape(captureSchema, raw)
export const parseNewTask = (raw: unknown): Shaped<NewTask> => shape(newTaskSchema, raw)
export const parsePatch = (raw: unknown): Shaped<TaskPatch> => shape(patchSchema, raw)
export const parseMove = (raw: unknown): Shaped<MoveInput> => shape(moveSchema, raw)
export const parseClose = (raw: unknown): Shaped<CloseInput> => shape(closeSchema, raw)
export const parseLink = (raw: unknown): Shaped<LinkInput> => shape(linkSchema, raw)

export function parseAccept(raw: unknown): Shaped<'backlog' | 'todo'> {
  const shaped = shape<{ readonly to: 'backlog' | 'todo' }>(acceptSchema, raw)
  return shaped.ok ? { ok: true, value: shaped.value.to } : shaped
}
