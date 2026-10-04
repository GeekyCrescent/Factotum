/**
 * THE ONLY zod schema for this module's config fragment.
 *
 * Only one, deliberately. Two validators of the same data drift, and zod strips keys
 * it does not know (CLAUDE.md §2): a field one side knew about and the other did not
 * would DISAPPEAR before reaching the engine, and here that data is the permission
 * boundary. One schema, in the module, and the engine receives what it produced.
 *
 * IT VALIDATES FORM AND ONLY FORM. Whether a path EXISTS is I/O, and this runs at step
 * 6 inside `composeModules`, which is SYNCHRONOUS. Existence is checked in `start()`,
 * at step 12, where the registry's try/catch turns a failure into a disabled module
 * instead of a dead daemon.
 *
 * AND NOTHING IN HERE MAY THROW. `boot.ts:55` calls `composeModules` with no
 * try/catch, and `load.ts:126` uses `safeParse`, which catches a validation FAILURE
 * but not an exception raised by the schema itself. So: no `.transform` that can
 * throw, no async refinement. The step is safe because of what is put in it, not by
 * itself.
 */

import { z } from 'zod'

/**
 * Every declared directory goes through this, sites and shared paths alike: both are
 * halves of the same boundary, and a rule that applied to one of them would be a rule
 * with a way around it.
 */
export const boundaryPath = z
  .string()
  .min(1)
  // Absolute, because a relative path would be resolved against whatever directory
  // the daemon happens to have been started from — which is not a boundary anybody
  // declared.
  .refine((value) => value.startsWith('/'), 'a site path must be absolute')
  // No `..`, because the boundary is checked against this string and a path that
  // climbs is a boundary that is hard to read and easy to get wrong.
  .refine((value) => !value.split('/').includes('..'), 'a site path must not contain ".."')

/**
 * Same shape as a module id: it names a lock file, so it cannot contain a slash. Exported because
 * every `:id` of a project in a route is checked against it BEFORE the engine sees it (spec
 * 2026-09-29, criterion 11), and a second copy of the pattern is the copy that drifts.
 */
/**
 * The ceiling of one attached file: 20 MiB. THE ONE LITERAL (spec 2026-10-01, D4). The route needs it
 * at step 8, before the engine exists, so it lives here and goes down from here — to the engine as
 * `uploadMaxBytes`, and to the screen through `view().uploads.maxBytes`. The screen keeps no copy.
 */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024

export const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/**
 * What a name must look like to reach an argv slot as `/<name>` or `--agent <name>`. A COPY of `NAME` in
 * `packages/sessions/src/catalog.ts`: this package cannot import that one (CLAUDE.md §1), so the rule is
 * declared twice and `packages/cli/src/invokable-name.test.ts` fails if the two ever differ.
 */
export const INVOKABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/

export const siteIdSchema = z.string().regex(SITE_ID_PATTERN, 'a site id must match /^[a-z0-9][a-z0-9-]*$/')

/** Exported so the projects registry is built from it (spec 2026-09-29, criterion 3). */
export const siteSchema = z.object({
  id: siteIdSchema,
  path: boundaryPath,
})

/**
 * `kind` is a plain string and `name` is optional, ON PURPOSE.
 *
 * A stricter schema would reject an entry naming a kind this build does not know — and
 * would take the WHOLE fragment with it, disabling the module over one bad row.
 * Criterion 14 says the opposite: that entry is disabled with its reason and the rest
 * of the catalog keeps working. The per-entry judgement therefore lives in the engine,
 * which can make it one entry at a time.
 */
const catalogEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  invoke: z.object({
    kind: z.string().min(1),
    name: z.string().optional(),
  }),
})

/** Every field has a default: a config with no `titles` titles with Haiku, thinking little. */
const titlesSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().min(1).default('haiku'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
})

export const sessionsConfigSchema = z
  .object({
    sites: z.array(siteSchema).default([]),
    catalog: z.array(catalogEntrySchema).default([]),
    /**
     * Directories writable from EVERY site — a notes vault is the case this exists for.
     *
     * A session has exactly one site, which is what keeps the boundary readable, so
     * without this the only way to let three agents share a vault is one site big
     * enough to contain everything: one lock, one agent at a time.
     *
     * NOTHING LAUNCHES INTO THEM AND NOTHING LOCKS THEM. Two agents writing the same
     * file in a shared path is not prevented, and that is the trade being made here
     * rather than a gap to close later.
     */
    sharedPaths: z.array(boundaryPath).default([]),
    /**
     * The titler (spec 2026-09-30, D9). `.prefault({})` and NOT `.default({})`: zod 4 hands a default
     * back WITHOUT parsing it, so the fields' own defaults would never apply — and tsc says so.
     */
    titles: titlesSchema.prefault({}),
    /**
     * Dictation (spec 2026-10-03, D3). Interpreted in start() by `dictation/config.ts`, NEVER here: a typo
     * in it must switch off dictation, not sessions — and a failure of this schema takes the whole fragment.
     */
    dictation: z.unknown().optional(),
  })
  // Duplicate ids are refused here rather than resolved somewhere later: two sites
  // with one id means two directories sharing one lock, which is the one thing the
  // lock exists to prevent.
  .refine(
    (value) => new Set(value.sites.map((site) => site.id)).size === value.sites.length,
    { message: 'two sites declare the same id', path: ['sites'] },
  )

/**
 * DERIVED FROM THE SCHEMA, not written out beside it.
 *
 * Writing the type by hand next to the schema is the second validator problem in
 * miniature: the two drift, and the one a reader reaches first is the one that wins.
 */
export type SessionsConfig = z.infer<typeof sessionsConfigSchema>
