/**
 * What `board.json` must look like to be loaded (design D3, criterion 3).
 *
 * `strictObject` AT EVERY LEVEL, and not out of tidiness: the store writes back what it read, and a
 * plain `z.object` drops a key it does not know — so a field written by a newer build would vanish
 * from disk on the first change after a rollback (CLAUDE.md §2). Refusing is the safe failure: the
 * module stays off with its reason, and the file is untouched.
 *
 * The limits are the ones the owner's input is held to (`shape.ts`), so nothing that passed the door
 * can fail here.
 */

import { z } from 'zod'
import { CYCLE_ID_PATTERN } from '../cycle.ts'
import {
  isCalendarDate,
  MAX_AREA_CHARS,
  MAX_ID_CHARS,
  MAX_LABEL_CHARS,
  MAX_LABELS,
  MAX_NOTES_CHARS,
  MAX_SUBTASK_CHARS,
  MAX_SUBTASKS,
  MAX_TITLE_CHARS,
} from '../shape.ts'
import { STATUSES, type Board } from '../types.ts'

const cycleId = z.string().regex(CYCLE_ID_PATTERN)
const iso = z.string().min(1).max(64)
const host = z.string().min(1).max(64).nullable()
const id = z.string().min(1).max(MAX_ID_CHARS)

const source = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('owner') }),
  z.strictObject({ kind: z.literal('capture'), raw: z.string().max(1000), parse: z.enum(['pending', 'ok', 'failed', 'skipped']) }),
  z.strictObject({ kind: z.literal('agent'), host, sessionId: id, siteId: id }),
])

const taskSchema = z.strictObject({
  id,
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  notes: z.string().max(MAX_NOTES_CHARS),
  status: z.enum(STATUSES),
  order: z.string().min(1).max(256),
  cycle: cycleId.nullable(),
  area: z.string().min(1).max(MAX_AREA_CHARS).nullable(),
  project: z.strictObject({ host, siteId: id }).nullable(),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  labels: z.array(z.string().min(1).max(MAX_LABEL_CHARS)).max(MAX_LABELS),
  estimate: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(8)]).nullable(),
  due: z.string().refine(isCalendarDate).nullable(),
  remindAt: iso.nullable(),
  remindedAt: iso.nullable(),
  reminderMissed: z.boolean(),
  subtasks: z.array(z.strictObject({ id, text: z.string().min(1).max(MAX_SUBTASK_CHARS), done: z.boolean() })).max(MAX_SUBTASKS),
  source,
  sessions: z.array(z.strictObject({ host, sessionId: id, at: iso })),
  createdAt: iso,
  updatedAt: iso,
  completedAt: iso.nullable(),
})

export const boardSchema = z.strictObject({
  version: z.literal(1),
  timeZone: z.string().min(1).max(64),
  openCycle: cycleId,
  tasks: z.array(taskSchema),
  cycles: z.array(
    z.strictObject({ id: cycleId, closedAt: iso, done: z.array(taskSchema), canceled: z.array(taskSchema), carried: z.array(id) }),
  ),
  agentCounts: z.record(id, z.number().int().min(0)),
  next: z
    .strictObject({
      at: iso,
      items: z.array(z.strictObject({ id, why: z.string().max(400) })).max(7),
      note: z.string().max(280),
    })
    .nullable(),
})

/** The board, or the first thing wrong with it as a path and zod's message — never a value. */
export function parseBoard(raw: unknown): { readonly ok: true; readonly board: Board } | { readonly ok: false; readonly reason: string } {
  const parsed = boardSchema.safeParse(raw)
  if (parsed.success) return { ok: true, board: parsed.data }
  const issue = parsed.error.issues[0]
  const path = issue === undefined || issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')
  return { ok: false, reason: `${path}: ${issue?.message ?? 'invalid'}` }
}
