/**
 * The shape of every new request body, checked HERE, in the module, before the engine sees it
 * (spec 2026-09-29, criterion 11; guardrail 11). Built from `config.ts` and `registry.ts`, so the
 * rule for a path or an id exists once.
 *
 * FORM ONLY. Nothing here touches the disk: whether a folder exists, is a directory, or is inside
 * another project is the engine's (design D2). A relative path, one with `..`, or an id that could
 * not name a lock file never gets that far: 400.
 */

import { join } from 'node:path'
import { z } from 'zod'
import { boundaryPath, siteIdSchema } from './config.ts'
import { colorSchema, NAME_MAX } from './registry.ts'
import type { Color } from './types.ts'

/** How many conversations one delete may name (criterion 34). */
export const REMOVE_MAX = 100

/** The shortest search worth running (criterion 38). */
export const SEARCH_MIN = 2

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/**
 * `~` and `~/…` as a person types them on a phone, made absolute with the daemon's home. Anything
 * else is left for `boundaryPath` to judge — which refuses it unless it is already absolute.
 */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

/** An optional name: trimmed, and empty means none. */
const nameSchema = z
  .string()
  .max(200)
  .transform((value) => value.trim())
  .pipe(z.string().max(NAME_MAX, `a name is at most ${NAME_MAX} characters`))
  .transform((value) => (value === '' ? undefined : value))

const projectRequestSchema = z.object({
  path: boundaryPath,
  id: siteIdSchema.optional(),
  name: nameSchema.optional(),
  color: colorSchema.optional(),
})

const projectPatchSchema = z.object({
  name: nameSchema.optional(),
  color: colorSchema.optional(),
})

function first(error: z.ZodError): string {
  const issue = error.issues[0]
  const where = issue?.path.join('.') ?? ''
  return `${where === '' ? '' : `${where}: `}${issue?.message ?? 'invalid'}`
}

function record(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
}

function withPath(body: unknown, home: string): Record<string, unknown> {
  const fields = record(body)
  return typeof fields['path'] === 'string' ? { ...fields, path: expandHome(fields['path'].trim(), home) } : fields
}

export function parseProjectRequest(
  body: unknown,
  home: string,
): Parsed<{ path: string; id: string | undefined; name: string | undefined; color: Color | undefined }> {
  const parsed = projectRequestSchema.safeParse(withPath(body, home))
  if (!parsed.success) return { ok: false, message: first(parsed.error) }
  const { path, id, name, color } = parsed.data
  return { ok: true, value: { path, id, name, color } }
}

export function parseSharedRequest(body: unknown, home: string): Parsed<string> {
  const parsed = z.object({ path: boundaryPath }).safeParse(withPath(body, home))
  return parsed.success ? { ok: true, value: parsed.data.path } : { ok: false, message: first(parsed.error) }
}

export function parseProjectPatch(body: unknown): Parsed<{ name: string | undefined; color: Color | undefined }> {
  const parsed = projectPatchSchema.safeParse(record(body))
  if (!parsed.success) return { ok: false, message: first(parsed.error) }
  return { ok: true, value: { name: parsed.data.name, color: parsed.data.color } }
}

/**
 * The engine trims and cuts it (criterion 30); here, only that it is text. EMPTY IS VALID: it clears
 * the owner's title (spec 2026-09-30, criterion 23).
 */
export function parseTitle(body: unknown): Parsed<string> {
  const title = record(body)['title']
  if (typeof title !== 'string') return { ok: false, message: 'a title must be text' }
  return { ok: true, value: title }
}

export function parseArchived(body: unknown): Parsed<boolean> {
  const archived = record(body)['archived']
  return typeof archived === 'boolean' ? { ok: true, value: archived } : { ok: false, message: '`archived` is true or false' }
}

export function parseIds(body: unknown): Parsed<readonly string[]> {
  const parsed = z
    .object({ ids: z.array(z.string()).min(1, 'name at least one conversation').max(REMOVE_MAX, `at most ${REMOVE_MAX} at once`) })
    .safeParse(record(body))
  return parsed.success ? { ok: true, value: parsed.data.ids } : { ok: false, message: first(parsed.error) }
}

export function parseQuery(q: string | undefined): Parsed<string> {
  const query = (q ?? '').trim()
  return query.length < SEARCH_MIN ? { ok: false, message: `search for at least ${SEARCH_MIN} characters` } : { ok: true, value: query }
}

export function isSiteId(value: string | undefined): value is string {
  return value !== undefined && siteIdSchema.safeParse(value).success
}
