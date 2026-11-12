/**
 * The `mockups` block of the config, and the only schema that knows its fields (design D8).
 *
 * THE MODULE CARRIES IT AS `z.unknown()` and `createMockups` parses it here, in `start()`: a bad block
 * switches off `mockups` with its reason, never the daemon (criterion 2; ADR-0004). `strictObject`,
 * so a mistyped key is a reason and not a silent default. A reason never carries a value.
 *
 * Paths are absolute; `~/` is expanded HERE, when the config is loaded, and nowhere else.
 */

import { z } from 'zod'
import { expandHome } from './paths.ts'
import { SITE_ID_PATTERN } from './shape.ts'

/** A COPY of `MODEL_NAME` (`packages/sessions/src/catalog.ts`): `opus[1m]` passes, `-p` does not. */
export const MODEL_NAME = /^[a-z0-9][a-z0-9.[\]-]{0,63}$/

const absolute = (home: string) =>
  z
    .string()
    .min(1, 'must not be empty')
    .transform((value, ctx) => {
      const expanded = expandHome(value, home)
      if (expanded === null || !expanded.startsWith('/')) {
        ctx.addIssue({ code: 'custom', message: 'must be an absolute path (or start with ~/)' })
        return z.NEVER
      }
      return expanded.replace(/\/+$/, '') || '/'
    })

const schema = (home: string) =>
  z.strictObject({
    docsSiteId: z.string().regex(SITE_ID_PATTERN, 'docsSiteId is the id of a sessions project, like "personal"'),
    vault: z.strictObject({
      projectsDir: absolute(home),
      mapFile: absolute(home)
        .refine((value) => value.endsWith('.md'), 'mapFile must be a .md file')
        .optional(),
    }),
    workRoot: absolute(home),
    model: z.string().regex(MODEL_NAME, 'model must match /^[a-z0-9][a-z0-9.[\\]-]{0,63}$/, like "opus[1m]"').optional(),
    crossWritesAllowed: z.boolean().default(false),
  })

export type MockupsConfig = z.output<ReturnType<typeof schema>>

export type ParsedConfig = { readonly ok: true; readonly config: MockupsConfig } | { readonly ok: false; readonly reason: string }

export function parseMockupsConfig(raw: unknown, home: string): ParsedConfig {
  const parsed = schema(home).safeParse(raw)
  if (parsed.success) return { ok: true, config: parsed.data }
  const issue = parsed.error.issues[0]
  const path = issue === undefined || issue.path.length === 0 ? 'mockups' : `mockups.${issue.path.join('.')}`
  return { ok: false, reason: `${path}: ${issue?.message ?? 'invalid'}` }
}
