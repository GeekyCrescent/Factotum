/**
 * Editing the permission boundary, as data.
 *
 * Declaring a site is the most consequential edit in the config — it is the whole of
 * what an agent may write — and until now it was done by hand in a JSON file, where a
 * missing comma disables the module and a wrong path widens the boundary silently.
 *
 * Everything here is PURE and returns a NEW config: the disk, the prompt and the
 * restart live in `site-command.ts`. Same split as `supervise.ts` / `install.ts`, for
 * the same reason — a decision about permissions should be testable without a home
 * directory.
 *
 * NOTHING LEAVES HERE THAT `factotum start` WOULD REFUSE. The edited config is parsed
 * back through the REAL schemas, module fragment included, exactly as `init` does. A
 * second copy of those rules here is the copy that drifts, and it would drift on the
 * rule that says where an agent may write.
 */

import { basename } from 'node:path'
import { rootConfigSchema } from '@factotum/core'
import { sessionsConfigSchema } from '@factotum/modules'

const SESSIONS = 'sessions'

/** The default entry, so a module that gets its first site can launch something. */
const FREE_ENTRY = { id: 'free', label: 'Free prompt', invoke: { kind: 'none' } }

export interface SiteEdit {
  readonly path: string
  readonly id?: string
  readonly shared?: boolean
}

export type EditResult = { readonly ok: true; readonly config: unknown } | { readonly ok: false; readonly error: string }

interface SessionsFragment {
  readonly enabled?: boolean
  readonly sites?: readonly { readonly id: string; readonly path: string }[]
  readonly sharedPaths?: readonly string[]
  readonly catalog?: readonly unknown[]
}

/**
 * A directory name turned into an id a lock file can carry.
 *
 * `undefined` rather than a generated `site-1` when nothing usable survives: an id
 * appears in every denial message this site ever produces, and one nobody recognises
 * is worse than being asked to type one.
 */
export function deriveId(path: string): string | undefined {
  const id = basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return /^[a-z0-9][a-z0-9-]*$/.test(id) ? id : undefined
}

export function listSites(config: unknown): {
  readonly sites: readonly { readonly id: string; readonly path: string }[]
  readonly sharedPaths: readonly string[]
} {
  const fragment = fragmentOf(config)
  return { sites: fragment.sites ?? [], sharedPaths: fragment.sharedPaths ?? [] }
}

export function addSite(config: unknown, edit: SiteEdit): EditResult {
  const fragment = fragmentOf(config)

  if (edit.shared === true) {
    if ((fragment.sharedPaths ?? []).includes(edit.path)) {
      return { ok: false, error: `${edit.path} is already a shared path` }
    }
    return validated(config, {
      ...withDefaults(fragment),
      sharedPaths: [...(fragment.sharedPaths ?? []), edit.path],
    })
  }

  const id = edit.id ?? deriveId(edit.path)
  if (id === undefined) {
    return { ok: false, error: `could not work out an id from ${edit.path} — pass --id` }
  }

  const sites = fragment.sites ?? []

  // The PATH is checked first on purpose. Re-adding the same directory is the common
  // mistake, and both checks would catch it — but only this one names the site that
  // already has it. It is also not a schema rule: two ids over one directory is two
  // locks over one tree, which is the overlap that makes a lock stop protecting
  // anything, and it is cheap to refuse here.
  const owner = sites.find((site) => site.path === edit.path)
  if (owner !== undefined) {
    return { ok: false, error: `${edit.path} is already declared as "${owner.id}"` }
  }
  if (sites.some((site) => site.id === id)) {
    return { ok: false, error: `a site with id "${id}" is already declared` }
  }

  return validated(config, { ...withDefaults(fragment), sites: [...sites, { id, path: edit.path }] })
}

/** `target` is a site id, or the path of a shared directory. */
export function removeSite(config: unknown, target: string): EditResult {
  const fragment = fragmentOf(config)
  const sites = fragment.sites ?? []
  const sharedPaths = fragment.sharedPaths ?? []

  if (sites.some((site) => site.id === target)) {
    return validated(config, { ...withDefaults(fragment), sites: sites.filter((site) => site.id !== target) })
  }
  if (sharedPaths.includes(target)) {
    return validated(config, {
      ...withDefaults(fragment),
      sharedPaths: sharedPaths.filter((path) => path !== target),
    })
  }
  return { ok: false, error: `no site or shared path "${target}" is declared` }
}

function fragmentOf(config: unknown): SessionsFragment {
  const modules = (config as { modules?: Record<string, unknown> } | null)?.modules ?? {}
  const fragment = modules[SESSIONS]
  return typeof fragment === 'object' && fragment !== null ? (fragment as SessionsFragment) : {}
}

/**
 * A module arriving here for the first time is switched ON and given the free-prompt
 * entry. A fragment with sites and an empty catalog would start and be able to launch
 * nothing, which reads as broken.
 */
function withDefaults(fragment: SessionsFragment): SessionsFragment {
  return {
    ...fragment,
    enabled: fragment.enabled ?? true,
    catalog: fragment.catalog === undefined || fragment.catalog.length === 0 ? [FREE_ENTRY] : fragment.catalog,
  }
}

/** The whole config back through both schemas — the module's fragment included. */
function validated(config: unknown, fragment: SessionsFragment): EditResult {
  const next = {
    ...(config as Record<string, unknown>),
    modules: { ...((config as { modules?: Record<string, unknown> }).modules ?? {}), [SESSIONS]: fragment },
  }

  const root = rootConfigSchema.safeParse(next)
  if (!root.success) {
    const issue = root.error.issues[0]
    return { ok: false, error: `${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'invalid'}` }
  }

  // The root schema keeps a module's fragment as an opaque record — validating it is
  // the module's job, and `boot` does it at step 6. Doing it here too is what stops
  // this command writing a file that disables the very module it was editing.
  const parsed = sessionsConfigSchema.safeParse(fragment)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: `sessions.${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'invalid'}` }
  }

  return { ok: true, config: next }
}
