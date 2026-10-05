/**
 * The `skills` block of this module's config (spec 2026-10-03-skills-a-mano, D5).
 *
 * IT DOES NOT RUN WHERE THE REST OF THE CONFIG RUNS, exactly like `dictation/config.ts`:
 * `sessionsConfigSchema` carries the block as `z.unknown()` and this is applied in `start()`, so a typo
 * in it switches off the owner's note and not sessions (criterion 16).
 *
 * A REASON NEVER CARRIES A VALUE, only a path and zod's message.
 */

import { z } from 'zod'

const skillsSchema = z.strictObject({
  notes: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('/'), 'notes must be an absolute path (no ~)')
    .refine((value) => !value.includes('\0'), 'notes must not contain a NUL'),
})

export type SkillsConfig =
  | { readonly kind: 'off' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'on'; readonly notes: string }

export function interpretSkillsConfig(raw: unknown): SkillsConfig {
  if (raw === undefined) return { kind: 'off' }
  const parsed = skillsSchema.safeParse(raw)
  if (parsed.success) return { kind: 'on', notes: parsed.data.notes }
  const issue = parsed.error.issues[0]
  const path = issue === undefined || issue.path.length === 0 ? 'skills' : `skills.${issue.path.join('.')}`
  return { kind: 'invalid', reason: `${path}: ${issue?.message ?? 'invalid'}` }
}
