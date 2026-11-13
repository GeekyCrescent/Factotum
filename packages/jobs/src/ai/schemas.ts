/**
 * What a CV run must come back as (design D5, `CvDoc`). The shape lives HERE, in zod, and the JSON
 * Schema handed to the CLI with `--json-schema` is derived from it: one definition, two uses (the
 * pattern of `packages/tasks/src/ai/schema.ts`).
 *
 * DRAFT-07, NOT ZOD'S DEFAULT: measured by the inbox with CLI 2.1.289, a schema declaring draft
 * 2020-12 is refused before the call (requirements §0.2, §0.9).
 *
 * THE LIMITS ARE GENEROUS ON PURPOSE except where the design fixes one (summary 600, gaps ≤ 5 of ≤ 160
 * each, v4 N2): an answer out of the schema costs a whole retry (D10), and whether the CV fits on a
 * page is decided by the PDF (D5 step 7), not by counting here.
 */

import { z } from 'zod'

import type { CvDoc } from '../types.ts'

/** design D5. */
export const MAX_SUMMARY_CHARS = 600
/** v4 (N2): requirements of the ad with no evidence in cv-maestro → `requirement-gap`. */
export const MAX_GAPS = 5
export const MAX_GAP_CHARS = 160

const MAX_LINE_CHARS = 200
const MAX_TEXT_CHARS = 400
const MAX_SOURCE_CHARS = 40
const MAX_ENTRIES = 12
const MAX_ITEMS = 30

const line = z.string().trim().min(1).max(MAX_LINE_CHARS)
const text = z.string().trim().min(1).max(MAX_TEXT_CHARS)
/** The section of cv-maestro a bullet comes from, like `§5.2` (D5 step 2). */
const source = z.string().trim().min(1).max(MAX_SOURCE_CHARS)

export const cvDocSchema = z.object({
  headline: line,
  summary: z.string().trim().min(1).max(MAX_SUMMARY_CHARS),
  experience: z
    .array(
      z.object({
        org: line,
        title: line,
        dates: line,
        place: line.nullable(),
        line: text.nullable(),
        bullets: z.array(z.object({ text, source })).max(MAX_ENTRIES),
      }),
    )
    .max(MAX_ENTRIES),
  projects: z.array(z.object({ name: line, role: line, status: line, text, source })).max(MAX_ENTRIES),
  education: z.array(z.object({ text })).max(MAX_ENTRIES),
  certifications: z.array(line).max(MAX_ITEMS),
  skills: z.array(z.object({ label: line, items: z.array(line).max(MAX_ITEMS) })).max(MAX_ENTRIES),
  gaps: z
    .array(z.object({ requirement: z.string().trim().min(1).max(MAX_GAP_CHARS), why: z.string().trim().min(1).max(MAX_GAP_CHARS) }))
    .max(MAX_GAPS),
})

/** The schema's output IS `CvDoc`: if the two drift apart, this line stops compiling. */
export const CV_DOC_OUTPUT: z.ZodType<CvDoc> = cvDocSchema

export const CV_DOC_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(cvDocSchema, { target: 'draft-7', io: 'input' }))
