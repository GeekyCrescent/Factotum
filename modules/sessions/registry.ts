/**
 * The projects registry: `projects.json` in this module's state directory, and THE DAEMON IS ITS
 * ONLY WRITER (spec 2026-09-29, D1; ADR-0011).
 *
 * WHY A FILE OF ITS OWN AND NOT THE CONFIG. A module cannot write `config.json` nor restart the
 * daemon (CLAUDE.md §1), and adding a project from the phone must not need either. So the config's
 * `sites` and `sharedPaths` SEED this file the first time, literally, and from then on this file is
 * the one source: what is only in the config is not loaded, and the start says so.
 *
 * ONE SCHEMA. The entries are built from `siteSchema` and `boundaryPath` in `config.ts`; a second
 * copy of "absolute, no `..`" here would be the copy that drifts, on the rule that says where an
 * agent may write. The types the engine sees are declared by hand in `types.ts` (ADR-0005) and the
 * store below is checked against them by the compiler.
 *
 * IT DEGRADES PER ENTRY, like the config. The envelope (`version` and two lists) is all or nothing;
 * each entry is judged on its own, and a bad one is SKIPPED, SAID, and KEPT: when the store writes,
 * it writes the skipped entries back as they were, so a rename from the phone never deletes in
 * silence what the owner typed by hand.
 *
 * WRITTEN FROM MEMORY. What somebody puts in the file while the daemon runs is ignored and
 * overwritten by the next write (criterion 5). With the daemon stopped, a hand edit is loaded at
 * the next start: that is the way to add a project without a phone.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { boundaryPath, SITE_ID_PATTERN, siteSchema } from './config.ts'
import type {
  Color,
  RegistryEdit,
  RegistryLoad,
  RegistryStore,
  RegistryUpdate,
  RegistryView,
  SkippedEntry,
} from './types.ts'

export const REGISTRY_FILE = 'projects.json'

export const NAME_MAX = 40

export const colorSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)])

export const projectEntrySchema = siteSchema.extend({
  name: z.string().max(NAME_MAX).optional(),
  color: colorSchema.optional(),
  addedAt: z.string().optional(),
})

export const sharedEntrySchema = z.object({ path: boundaryPath, addedAt: z.string().optional() })

export const registrySchema = z.object({
  version: z.literal(1),
  projects: z.array(projectEntrySchema),
  shared: z.array(sharedEntrySchema),
})

/** THE SOURCE OF THE TYPES: the engine's `RegistryView` is its read-only mirror. */
export type Registry = z.infer<typeof registrySchema>
type ProjectEntry = z.infer<typeof projectEntrySchema>
type SharedEntry = z.infer<typeof sharedEntrySchema>

/** The envelope alone: each entry is parsed on its own below. */
const envelopeSchema = z.object({
  version: z.literal(1),
  projects: z.array(z.unknown()),
  shared: z.array(z.unknown()),
})

export function registryFile(stateDir: string): string {
  return join(stateDir, REGISTRY_FILE)
}

/**
 * `~/.factotum`, from this module's `ctx.stateDir` (`~/.factotum/<env>/modules/sessions`). A test in
 * the composition root, which sees both, checks it against the kernel's `statePaths` so a change of
 * layout cannot pass in silence.
 */
export function factotumRootOf(stateDir: string): string {
  return join(stateDir, '..', '..', '..')
}

/**
 * A folder name turned into an id a lock file can carry. `undefined` rather than a made-up `site-1`
 * when nothing usable survives: an id appears in every denial the project ever produces.
 */
export function deriveId(name: string): string | undefined {
  const id = basename(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return isValidId(id) ? id : undefined
}

export function isValidId(id: string): boolean {
  return SITE_ID_PATTERN.test(id)
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

export type RegistryRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'broken'; readonly reason: string }
  | {
      readonly kind: 'ok'
      readonly registry: Registry
      readonly warnings: readonly string[]
      readonly skipped: readonly SkippedEntry[]
      /** The skipped entries AS THEY WERE, to be written back untouched. */
      readonly raw: { readonly projects: readonly unknown[]; readonly shared: readonly unknown[] }
    }

/**
 * Reads the file. `missing` ONLY on ENOENT: any other failure to read it is `broken`, never a
 * reason to seed over it (criterion 1). Used by the store and by `factotum site list` and `doctor`.
 */
export async function readRegistry(file: string): Promise<RegistryRead> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'broken', reason: `${file} cannot be read: ${(error as NodeJS.ErrnoException).code ?? 'error'}` }
  }
  return parseRegistry(text, file)
}

export function parseRegistry(text: string, file: string): RegistryRead {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { kind: 'broken', reason: `${file} is not valid JSON` }
  }
  const envelope = envelopeSchema.safeParse(json)
  if (!envelope.success) {
    const issue = envelope.error.issues[0]
    return { kind: 'broken', reason: `${file}: ${issue?.path.join('.') || 'the file'}: ${issue?.message ?? 'invalid'}` }
  }

  const warnings: string[] = []
  const skipped: SkippedEntry[] = []
  const raw: { projects: unknown[]; shared: unknown[] } = { projects: [], shared: [] }
  const skip = (list: 'projects' | 'shared', index: number, entry: unknown, reason: string) => {
    skipped.push({ list, index, reason })
    raw[list].push(entry)
    warnings.push(`${file}: ${list}[${index}] skipped: ${reason}`)
  }

  const projects: ProjectEntry[] = []
  envelope.data.projects.forEach((entry, index) => {
    const parsed = projectEntrySchema.safeParse(entry)
    if (!parsed.success) return skip('projects', index, entry, describe(parsed.error))
    if (projects.some((p) => p.id === parsed.data.id)) return skip('projects', index, entry, `the id "${parsed.data.id}" is already taken`)
    if (projects.some((p) => p.path === parsed.data.path)) return skip('projects', index, entry, `${parsed.data.path} is already a project`)
    projects.push(parsed.data)
  })

  const shared: SharedEntry[] = []
  envelope.data.shared.forEach((entry, index) => {
    const parsed = sharedEntrySchema.safeParse(entry)
    if (!parsed.success) return skip('shared', index, entry, describe(parsed.error))
    if (shared.some((s) => s.path === parsed.data.path)) return skip('shared', index, entry, `${parsed.data.path} is already shared`)
    shared.push(parsed.data)
  })

  return { kind: 'ok', registry: { version: 1, projects, shared }, warnings, skipped, raw }
}

function describe(error: z.ZodError): string {
  const issue = error.issues[0]
  const where = issue?.path.join('.') ?? ''
  return `${where === '' ? '' : `${where}: `}${issue?.message ?? 'invalid'}`
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export interface RegistrySeed {
  readonly sites: readonly { readonly id: string; readonly path: string }[]
  readonly sharedPaths: readonly string[]
}

export interface RegistryStoreDeps {
  readonly file: string
  /** The config's fragment, already parsed: it seeds the file when there is none. */
  readonly seed: RegistrySeed
  readonly now: () => Date
  /** Injected so a test can make a write fail (criterion 4). */
  readonly write?: (file: string, text: string) => Promise<void>
}

/** Temp + rename: a crash mid-write leaves the old file or the new one, never half of either. */
async function writeAtomically(file: string, text: string): Promise<void> {
  const temp = `${file}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, file)
}

type Raw = { readonly projects: readonly unknown[]; readonly shared: readonly unknown[] }

export function createRegistryStore(deps: RegistryStoreDeps): RegistryStore {
  const write = deps.write ?? writeAtomically
  let memory: Registry | undefined
  let raw: Raw = { projects: [], shared: [] }
  let broken: string | undefined
  let chain: Promise<unknown> = Promise.resolve()

  const serialise = (registry: Registry): string =>
    `${JSON.stringify({ version: 1, projects: [...registry.projects, ...raw.projects], shared: [...registry.shared, ...raw.shared] }, null, 2)}\n`

  const load = async (): Promise<RegistryLoad> => {
    const read = await readRegistry(deps.file)
    if (read.kind === 'broken') {
      broken = read.reason
      return { kind: 'broken', reason: read.reason }
    }
    if (read.kind === 'ok') {
      memory = read.registry
      raw = read.raw
      // ONE SOURCE (criterion 2): with a registry, what is only in the config is not loaded — and
      // the start says so, or a site added to the config by hand would vanish without a word.
      const ignored = [
        ...deps.seed.sites.filter((site) => !read.registry.projects.some((p) => p.id === site.id)).map((site) => `site "${site.id}"`),
        ...deps.seed.sharedPaths.filter((path) => !read.registry.shared.some((s) => s.path === path)).map((path) => `shared path ${path}`),
      ]
      const said = ignored.map((what) => `${what} is in the config but not in ${deps.file}: not loaded (projects live in that file now)`)
      return { kind: 'ok', registry: read.registry, warnings: [...read.warnings, ...said], skipped: read.skipped }
    }
    // ENOENT, and only ENOENT: the config, literally. No realpath and no existence check: a folder
    // that is missing today is `missing` in the engine, not a reason to drop it (criterion 1).
    const seeded = parseRegistry(
      JSON.stringify({
        version: 1,
        projects: deps.seed.sites.map((site) => ({ id: site.id, path: site.path })),
        shared: deps.seed.sharedPaths.map((path) => ({ path })),
      }),
      deps.file,
    )
    // Built here from a fragment the same schemas validated: an envelope this function wrote.
    /* node:coverage ignore next */
    if (seeded.kind !== 'ok') throw new Error('unreachable: the seed envelope is built above')
    memory = seeded.registry
    raw = seeded.raw
    const warnings = [...seeded.warnings, `seeded ${deps.file} from the config: ${seeded.registry.projects.length} project(s), ${seeded.registry.shared.length} shared`]
    try {
      await write(deps.file, serialise(seeded.registry))
    } catch (error) {
      // THE SEED THAT CANNOT BE WRITTEN is not a broken registry: the module runs on it from memory
      // and the next change tries the disk again. Refusing to start over it would cost the owner
      // every project for a state directory that is, say, momentarily full.
      warnings.push(`could not write ${deps.file} (${(error as NodeJS.ErrnoException).code ?? 'error'}); running on the seed from memory`)
    }
    return { kind: 'ok', registry: seeded.registry, warnings, skipped: seeded.skipped }
  }

  const update: RegistryStore['update'] = (decide) => {
    const work = async (): Promise<RegistryUpdate> => {
      if (broken !== undefined) return { kind: 'broken', reason: broken }
      const current = memory
      if (current === undefined) return { kind: 'broken', reason: 'the registry has not been loaded' }
      const decided = await decide(current)
      if ('refused' in decided) return { kind: 'refused', reason: decided.refused }
      const next = apply(current, decided, deps.now().toISOString())
      if (typeof next === 'string') return { kind: 'refused', reason: next }
      try {
        await write(deps.file, serialise(next))
      } catch (error) {
        return { kind: 'failed', reason: `could not write ${deps.file}: ${(error as NodeJS.ErrnoException).code ?? 'error'}` }
      }
      // ONLY NOW: memory follows the disk, never the other way round (store.ts, the same pattern).
      memory = next
      return { kind: 'ok', registry: next }
    }
    const next = chain.then(work, work)
    // The stored link swallows the failure so the next write is not poisoned by this one.
    chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  return { file: deps.file, load, update, deriveId, isValidId }
}

/** The edit on a COPY. A string is a refusal: the last line of defence behind `decide`. */
function apply(current: Registry, edit: RegistryEdit, at: string): Registry | string {
  switch (edit.kind) {
    case 'add-project': {
      if (current.projects.some((p) => p.id === edit.id)) return `the id "${edit.id}" is already taken`
      if (current.projects.some((p) => p.path === edit.path)) return 'that folder is already a project'
      const entry = projectEntrySchema.safeParse({ id: edit.id, path: edit.path, name: edit.name, color: edit.color, addedAt: at })
      if (!entry.success) return describe(entry.error)
      return { ...current, projects: [...current.projects, stripUndefined(entry.data)] }
    }
    case 'set-project': {
      const found = current.projects.find((p) => p.id === edit.id)
      if (found === undefined) return `no project "${edit.id}"`
      const entry = projectEntrySchema.safeParse({ ...found, name: edit.name, color: edit.color })
      if (!entry.success) return describe(entry.error)
      return { ...current, projects: current.projects.map((p) => (p.id === edit.id ? stripUndefined(entry.data) : p)) }
    }
    case 'remove-project':
      if (!current.projects.some((p) => p.id === edit.id)) return `no project "${edit.id}"`
      return { ...current, projects: current.projects.filter((p) => p.id !== edit.id) }
    case 'add-shared': {
      if (current.shared.some((s) => s.path === edit.path)) return 'that folder is already shared'
      const entry = sharedEntrySchema.safeParse({ path: edit.path, addedAt: at })
      if (!entry.success) return describe(entry.error)
      return { ...current, shared: [...current.shared, stripUndefined(entry.data)] }
    }
    case 'remove-shared':
      if (!current.shared.some((s) => s.path === edit.path)) return 'that folder is not shared'
      return { ...current, shared: current.shared.filter((s) => s.path !== edit.path) }
  }
}

/** So an unset name or colour is absent in the file rather than `null`-ish noise. */
function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

/** A colour from anything, for the request bodies. */
export function colorOf(value: unknown): Color | undefined {
  const parsed = colorSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
