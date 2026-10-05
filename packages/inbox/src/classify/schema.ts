/**
 * What one batch must come back as (spec 2026-10-05, D6). The shape lives HERE, in zod, and the JSON
 * Schema handed to the CLI with `--json-schema` is derived from it: one definition, two uses.
 */

import { z } from 'zod'

export const verdictSchema = z.object({
  id: z.string(),
  category: z.enum(['action', 'unsubscribe', 'spam', 'info']),
  /** Only for `action`. One that arrives without it is kept as is; the screen counts it as `medium` (criterion 13). */
  priority: z.enum(['high', 'medium', 'low']).optional(),
  ask: z.string().max(300).optional(),
  due: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  why: z.string().max(300),
  draft: z.string().max(4_000).optional(),
})

export const batchSchema = z.object({ items: z.array(verdictSchema) })

export type Verdict = Omit<z.infer<typeof verdictSchema>, 'id'>

/**
 * What `--json-schema` receives. DRAFT-07, NOT ZOD'S DEFAULT: measured with CLI 2.1.289, a schema
 * declaring draft 2020-12 is refused before the call ("no schema with key or ref
 * https://json-schema.org/draft/2020-12/schema"), exit 1.
 */
export const BATCH_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(batchSchema, { target: 'draft-7' }))
