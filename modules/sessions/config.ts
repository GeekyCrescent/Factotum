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

const siteSchema = z.object({
  /** Same shape as a module id: it names a lock file, so it cannot contain a slash. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'a site id must match /^[a-z0-9][a-z0-9-]*$/'),
  path: z
    .string()
    .min(1)
    // Absolute, because a relative path would be resolved against whatever directory
    // the daemon happens to have been started from — which is not a boundary anybody
    // declared.
    .refine((value) => value.startsWith('/'), 'a site path must be absolute')
    // No `..`, because the boundary is checked against this string and a path that
    // climbs is a boundary that is hard to read and easy to get wrong.
    .refine((value) => !value.split('/').includes('..'), 'a site path must not contain ".."'),
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

export const sessionsConfigSchema = z
  .object({
    sites: z.array(siteSchema).default([]),
    catalog: z.array(catalogEntrySchema).default([]),
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
