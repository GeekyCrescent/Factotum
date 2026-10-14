/**
 * What a capture must come back as (design D5). The shape lives HERE, in zod, and the JSON Schema
 * handed to the CLI with `--json-schema` is derived from it: one definition, two uses.
 *
 * THE PROJECT IS A SHORT ID (`p0`, `p1`…) from the list the prompt carries, not `{ host, siteId }`:
 * the inbox does the same with its `b0`, for the same reason — a model copies a short token back
 * reliably, and a `host: null` is one more thing to get wrong. `capture.ts` maps it back.
 */

import { z } from 'zod'
import { isCalendarDate, MAX_TITLE_CHARS } from '../shape.ts'

export const captureOutputSchema = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
  area: z.string().nullable(),
  project: z.string().nullable(),
  due: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isCalendarDate)
    .nullable(),
  // Literals, so the type IS `Priority` and nothing downstream needs a cast.
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
})

export type CaptureOutput = z.infer<typeof captureOutputSchema>

/**
 * What `--json-schema` receives. DRAFT-07, NOT ZOD'S DEFAULT: measured by the inbox with CLI 2.1.289,
 * a schema declaring draft 2020-12 is refused before the call (requirements §0.9).
 */
export const CAPTURE_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(captureOutputSchema, { target: 'draft-7', io: 'input' }))
