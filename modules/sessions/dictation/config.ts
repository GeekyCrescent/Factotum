/**
 * The `dictation` block of this module's config, and the only schema that knows its fields (spec
 * 2026-10-03, D3).
 *
 * IT DOES NOT RUN WHERE THE REST OF THE CONFIG RUNS. `sessionsConfigSchema` carries the block as
 * `z.unknown()`, and this is applied in `start()`. A typo in here must switch off dictation, not
 * sessions — and a failure of the main schema takes the whole fragment with it (CLAUDE.md §5).
 *
 * `strictObject`, NOT `object`: `z.object` drops an unknown key without a word, so `"vocabularly"` would
 * leave dictation on, without its terms and without a warning (criterion 4).
 *
 * A REASON NEVER CARRIES A VALUE, only a path and zod's message — which, in zod 4, does not quote the
 * input. Somebody who pastes the key where its path goes must not find it in the log (criterion 18).
 */

import { z } from 'zod'
import { DEFAULT_MODEL, MAX_TERM_CHARS, MAX_TERMS } from './shape.ts'

const dictationSchema = z.strictObject({
  apiKeyFile: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('/'), 'apiKeyFile must be an absolute path (no ~)'),
  model: z.string().min(1).default(DEFAULT_MODEL),
  language: z.string().regex(/^[a-z]{2}$/, 'language is a two-letter ISO 639-1 code, like "es"').optional(),
  vocabulary: z.array(z.string().trim().min(1).max(MAX_TERM_CHARS)).max(MAX_TERMS).default([]),
})

export type DictationConfig = z.infer<typeof dictationSchema>

export type ParsedDictation =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly config: DictationConfig }
  | { readonly kind: 'invalid'; readonly reason: string }

export function parseDictation(raw: unknown): ParsedDictation {
  if (raw === undefined) return { kind: 'absent' }
  const parsed = dictationSchema.safeParse(raw)
  if (parsed.success) return { kind: 'ok', config: parsed.data }
  const issue = parsed.error.issues[0]
  const path = issue === undefined || issue.path.length === 0 ? 'dictation' : `dictation.${issue.path.join('.')}`
  return { kind: 'invalid', reason: `${path}: ${issue?.message ?? 'invalid'}` }
}
