/**
 * The shape of every new request body, checked HERE, in the module, before the engine sees it
 * (spec 2026-09-29, criterion 11; guardrail 11). Built from `config.ts` and `registry.ts`, so the
 * rule for a path or an id exists once.
 *
 * FORM ONLY. Nothing here touches the disk: whether a folder exists, is a directory, or is inside
 * another project is the engine's (design D2). A relative path, one with `..`, or an id that could
 * not name a lock file never gets that far: 400.
 */

import { join, normalize } from 'node:path'
import { z } from 'zod'
import { boundaryPath, siteIdSchema } from './config.ts'
import { CATEGORIES_MAX, categoryIdSchema, colorSchema, NAME_MAX } from './registry.ts'
import type { Color, FilesQuery, ProjectLayout } from './types.ts'

/** How many conversations one delete may name (criterion 34). */
export const REMOVE_MAX = 100

/** How many projects one layout may place: far past any owner's, short of a body built to hurt. */
export const LAYOUT_PROJECTS_MAX = 500

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
  // Several sessions at once (spec 2026-10-03-varias-sesiones-por-proyecto, D5). Not sent = unchanged.
  concurrent: z.boolean().optional(),
})

/** A category's name: trimmed, and REQUIRED — a header with nothing in it is not one to find. */
const categoryNameSchema = z
  .string()
  .max(200)
  .transform((value) => value.trim())
  .pipe(z.string().min(1, 'a category needs a name').max(NAME_MAX, `a category name is at most ${NAME_MAX} characters`))

const layoutSchema = z
  .object({
    categories: z.array(z.object({ id: categoryIdSchema, name: categoryNameSchema })).max(CATEGORIES_MAX, `at most ${CATEGORIES_MAX} categories`),
    order: z
      .array(z.object({ id: siteIdSchema, category: categoryIdSchema.optional() }))
      .max(LAYOUT_PROJECTS_MAX, `at most ${LAYOUT_PROJECTS_MAX} projects`),
  })
  .superRefine((layout, ctx) => {
    const categories = new Set(layout.categories.map((c) => c.id))
    if (categories.size !== layout.categories.length) ctx.addIssue({ code: 'custom', path: ['categories'], message: 'a category is there twice' })
    const ids = new Set(layout.order.map((placed) => placed.id))
    if (ids.size !== layout.order.length) ctx.addIssue({ code: 'custom', path: ['order'], message: 'a project is there twice' })
    const unknown = layout.order.find((placed) => placed.category !== undefined && !categories.has(placed.category))
    if (unknown !== undefined) ctx.addIssue({ code: 'custom', path: ['order'], message: `no category "${unknown.category}"` })
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

export function parseProjectPatch(
  body: unknown,
): Parsed<{ name: string | undefined; color: Color | undefined; concurrent: boolean | undefined }> {
  const parsed = projectPatchSchema.safeParse(record(body))
  if (!parsed.success) return { ok: false, message: first(parsed.error) }
  return { ok: true, value: { name: parsed.data.name, color: parsed.data.color, concurrent: parsed.data.concurrent } }
}

/**
 * The SHAPE of a layout: ids that could be ids, names that are names, nothing twice, and no category
 * named that is not sent. Whether it places exactly the projects there are is the engine's, inside
 * the registry's queue: only there is "the projects there are" a fact rather than a guess.
 */
export function parseLayout(body: unknown): Parsed<ProjectLayout> {
  const parsed = layoutSchema.safeParse(record(body))
  if (!parsed.success) return { ok: false, message: first(parsed.error) }
  return {
    ok: true,
    value: {
      categories: parsed.data.categories.map(({ id, name }) => ({ id, name })),
      order: parsed.data.order.map(({ id, category }) => ({ id, category })),
    },
  }
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

/** The longest filter worth sending: a name, not a path (spec 2026-10-01-referencias-y-tab, D6). */
export const PREFIX_MAX = 255

const HAS_NUL = /\u0000/

/**
 * `GET /files`: the FORM of the folder asked for, here like every path (design D1). The rule is
 * `boundaryPath`'s — absolute, no `..` — plus what a listing adds: no `.` segment, no NUL, nothing
 * `normalize` would change, no trailing slash. Nothing is repaired: a path that needs repairing was
 * built by hand, and the screen never builds one. The message is this route's own: a `dir` is not a
 * site, and `boundaryPath` says "a site path".
 */
export function parseFilesQuery(query: Readonly<Record<string, string | undefined>>): Parsed<FilesQuery> {
  const siteId = query['site']
  if (!isSiteId(siteId)) return { ok: false, message: 'that is not a project id' }
  const dir = query['dir']
  if (dir !== undefined && !isFolderPath(dir)) {
    return { ok: false, message: 'dir must be an absolute folder path, written plainly: no ".", "..", "//" or trailing "/"' }
  }
  const prefix = query['prefix'] ?? ''
  if (prefix.length > PREFIX_MAX || prefix.includes('/') || HAS_NUL.test(prefix)) {
    return { ok: false, message: `a prefix is part of one name: no "/", at most ${PREFIX_MAX} characters` }
  }
  return { ok: true, value: { siteId, dir, prefix } }
}

function isFolderPath(dir: string): boolean {
  if (!boundaryPath.safeParse(dir).success || HAS_NUL.test(dir)) return false
  if (dir.split('/').includes('.')) return false
  return normalize(dir) === dir && (dir === '/' || !dir.endsWith('/'))
}
