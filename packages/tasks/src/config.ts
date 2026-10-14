/**
 * The `tasks` block of the config, and the only schema that knows its fields (design D12).
 *
 * THE MODULE CARRIES IT AS `z.unknown()` and `createTasks` parses it here, in `start()`: a bad block
 * switches off `tasks` with its reason, never the daemon nor `sessions` (criterion 1, guardrail 6).
 *
 * `strictObject`: `z.object` drops an unknown key without a word, so a mistyped `"timezone"` would
 * run in the zone of the process with no warning.
 *
 * A REASON NEVER CARRIES A VALUE, only a path and a message of our own or zod's — which, in zod 4,
 * does not quote the input.
 */

import { z } from 'zod'
import { HOST_NAME_PATTERN } from './shape.ts'

/**
 * A COPY of `MODEL_NAME` (`packages/inbox/src/config.ts`), as the inbox copies `SITE_ID_PATTERN`:
 * this package does not import the inbox. Never a leading `-`, so it cannot become a flag.
 */
export const MODEL_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/

/** Does `Intl` know this zone? It throws a RangeError for one it does not. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export const tasksConfigSchema = z
  .strictObject({
    mode: z.enum(['board', 'relay'], { error: 'mode is "board" or "relay"' }).default('board'),
    timeZone: z.string().refine(isTimeZone, 'timeZone must be a zone Intl accepts, like "Australia/Sydney"').optional(),
    /**
     * `sonnet` BY MEASUREMENT (tasks A2, §M): on 20 captures it was the cheapest that met the schema and
     * the dates 20 of 20 — and the fastest. The inbox's rule: the cheapest that works.
     */
    model: z.string().regex(MODEL_NAME, 'model must match /^[a-z0-9][a-z0-9.-]{0,63}$/, like "sonnet"').default('sonnet'),
    /** No default: A2 measured `haiku` with `low` dearer and slower than without (design D5). */
    effort: z.enum(['low', 'medium', 'high'], { error: 'effort is "low", "medium" or "high"' }).optional(),
    relayTo: z.string().regex(HOST_NAME_PATTERN, 'relayTo is a machine name, like omarchy').optional(),
  })
  .refine((value) => value.mode !== 'relay' || value.relayTo !== undefined, {
    message: 'relay mode needs relayTo: the name of the host that keeps the board',
    path: ['relayTo'],
  })
  .refine((value) => value.mode === 'relay' || value.relayTo === undefined, {
    message: 'relayTo only makes sense in relay mode',
    path: ['relayTo'],
  })

export type TasksConfig = z.infer<typeof tasksConfigSchema>

export type ParsedConfig =
  | { readonly ok: true; readonly config: TasksConfig; readonly timeZone: string }
  | { readonly ok: false; readonly reason: string }

export function parseTasksConfig(raw: unknown): ParsedConfig {
  const parsed = tasksConfigSchema.safeParse(raw)
  if (parsed.success) {
    // S7: the zone of the process by default — which A3 measured as the right one on the board's host.
    const timeZone = parsed.data.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    return { ok: true, config: parsed.data, timeZone }
  }
  const issue = parsed.error.issues[0]
  const path = issue === undefined || issue.path.length === 0 ? 'tasks' : `tasks.${issue.path.join('.')}`
  return { ok: false, reason: `${path}: ${issue?.message ?? 'invalid'}` }
}
