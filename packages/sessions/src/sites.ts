/**
 * A site is a declared directory, and the whole permission boundary rests on it.
 *
 * Declared, never discovered. The predecessor project declares roots and treats every
 * git repository underneath as launchable, which works for one person with a layout
 * she built herself. Here a discovered site would be a site nobody authorised — and it
 * is the same shape the bind already has: auto-detection lives in `init` and never at
 * startup.
 */

import { stat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import type { Timers } from '@factotum/core'
import { bounded } from './bounded.ts'
import type { SiteConfig } from './types.ts'

export interface Site {
  readonly id: string
  /** As declared, normalised, no trailing separator. */
  readonly path: string
  /**
   * The same directory with symlinks resolved.
   *
   * ON macOS THIS IS NOT COSMETIC. `/tmp` is a symlink to `/private/tmp`, and the CLI
   * reports `cwd` and builds `file_path` in RESOLVED form: a site declared as
   * `/tmp/work` receives tool inputs under `/private/tmp/work`. Containment is checked
   * against BOTH spellings, which is not a weakening — they name the same inode, and
   * the owner authorised that directory once.
   */
  readonly realPath: string
  readonly isRepo: boolean
}

/**
 * Is `target` inside `root`?
 *
 * THE SEPARATOR IS THE POINT. Without it `/a/bc` passes for being inside `/a/b`,
 * which is a sibling directory the owner never authorised.
 */
export function contains(root: string, target: string): boolean {
  const cleanRoot = trimTrailing(normalize(root))
  const cleanTarget = trimTrailing(normalize(target))
  if (cleanTarget === cleanRoot) return true
  return cleanTarget.startsWith(cleanRoot.endsWith(sep) ? cleanRoot : cleanRoot + sep)
}

/** Inside the site by EITHER spelling. See `Site.realPath`. */
export function insideSite(site: Site, target: string): boolean {
  return contains(site.path, target) || contains(site.realPath, target)
}

function trimTrailing(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path
}

/**
 * THE FORM IS VALIDATED BY THE MODULE'S SCHEMA. This is the other half and it is I/O, so
 * it never runs from `routes()`, where it would take the daemon down with a raw stack.
 *
 * It THROWS, and the engine never lets that throw reach `start()` any more: it calls this
 * through `checkSite`, which turns it into `missing` FOR THAT SITE ALONE (spec 2026-09-29,
 * criterion 23; ADR-0011, which amends ADR-0004 here). Until then a folder that was not
 * there disabled the whole module. That only ever narrowed the boundary, and it still
 * does: a `missing` site launches nothing, is not read, and gives no session a path.
 */
export async function inspectSite(config: SiteConfig): Promise<Site> {
  const path = trimTrailing(normalize(config.path))

  if (!isAbsolute(path)) {
    throw new Error(`site "${config.id}": path ${JSON.stringify(config.path)} is not absolute`)
  }

  let info
  try {
    info = await stat(path)
  } catch {
    throw new Error(`site "${config.id}": ${path} does not exist`)
  }
  if (!info.isDirectory()) {
    throw new Error(`site "${config.id}": ${path} is not a directory`)
  }

  // A failure here means the path exists but cannot be resolved; keep the declared
  // spelling rather than refusing a site over a symlink subtlety.
  let realPath = path
  try {
    realPath = trimTrailing(await realpath(path))
  } catch {
    /* keep `path` */
  }

  return { id: config.id, path, realPath, isRepo: await isRepo(path) }
}

/** Git is OPTIONAL. A site that is not a repository is launched with no checks at all. */
async function isRepo(path: string): Promise<boolean> {
  try {
    // A worktree's `.git` is a FILE, not a directory, so `stat` and not `isDirectory`.
    await stat(join(path, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * Where a tool wants to write, as an absolute path.
 *
 * Relative inputs are resolved against the session's `cwd`, which is what the CLI
 * reports in the hook payload — not against `process.cwd()`, which is the daemon's and
 * has nothing to do with the agent.
 */
export function resolveAgainst(cwd: string, target: string): string {
  return trimTrailing(isAbsolute(target) ? normalize(target) : resolve(cwd, target))
}

// ---------------------------------------------------------------------------
// Per-site state and the rules for a new folder (spec 2026-09-29, design D2)
// ---------------------------------------------------------------------------

export type SiteCheck = { readonly status: 'ok'; readonly site: Site } | { readonly status: 'missing'; readonly reason: string }

/** `inspectSite`, as a value: a folder that is not there is `missing`, and only that site. */
export async function checkSite(config: SiteConfig): Promise<SiteCheck> {
  try {
    return { status: 'ok', site: await inspectSite(config) }
  } catch (error) {
    return { status: 'missing', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** What the rules read from the disk. Injected so a test can hang it (criterion 15). */
export interface DiskProbe {
  readonly realpath: (path: string) => Promise<string>
  readonly isDirectory: (path: string) => Promise<boolean>
}

export const realDisk: DiskProbe = {
  realpath: async (path) => await realpath(path),
  isDirectory: async (path) => (await stat(path)).isDirectory(),
}

/**
 * The `realpath` of the nearest ancestor that exists, plus the segments that do not. NEVER THROWS.
 *
 * So a project whose folder is missing still has a place in the tree: `/tmp/factotum-proyecto-a`
 * gone is still `/private/tmp/factotum-proyecto-a`, and `/tmp` cannot be registered over it
 * because it happens to be missing today (criterion 12).
 */
export async function canonicalPath(path: string, disk: DiskProbe = realDisk): Promise<string> {
  let current = trimTrailing(normalize(path))
  const missing: string[] = []
  for (;;) {
    try {
      const real = trimTrailing(await disk.realpath(current))
      return missing.length === 0 ? real : join(real, ...[...missing].reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return missing.length === 0 ? current : join(current, ...[...missing].reverse())
      missing.push(basename(current))
      current = parent
    }
  }
}

/** How long checking a new folder may take, inside the registry's queue (criterion 15, R11). */
export const CANDIDATE_TIMEOUT_MS = 5_000

export interface CandidateWorld {
  readonly home: string
  readonly factotumRoot: string
  readonly installRoot: string | undefined
  /** The registry as it is NOW: inside the queue when approving, so it includes the last approval. */
  readonly projects: readonly SiteConfig[]
  readonly shared: readonly string[]
  readonly timers: Timers
  /** macOS: the disk does not tell `Web` from `web`, so neither may the rules. */
  readonly caseInsensitive: boolean
  readonly disk?: DiskProbe
  readonly timeoutMs?: number
}

export type Candidate =
  | { readonly ok: true; readonly realPath: string; readonly base: string }
  | { readonly ok: false; readonly reason: string }

/**
 * May this folder become a project, or a shared folder? ON THE DISK: the form was the module's.
 *
 * On the RESOLVED path, which must exist and be a folder: never `/`, never the home, never
 * `factotumRoot` or the checkout this daemon runs from, with what is inside or above them. A
 * project may not equal, contain or sit inside another project, whether or not that one's folder
 * is there. A shared folder only may not repeat: sitting inside a project is what it is for.
 *
 * The id is NOT decided here: this returns the resolved folder's `base`, and the engine asks the
 * module for the id, so the id rule lives in one place.
 */
export async function checkCandidate(path: string, kind: 'project' | 'shared', world: CandidateWorld): Promise<Candidate> {
  return await bounded(
    judge(path, kind, world),
    world.timeoutMs ?? CANDIDATE_TIMEOUT_MS,
    world.timers,
    (): Candidate => ({ ok: false, reason: 'checking that folder timed out' }),
  )
}

async function judge(path: string, kind: 'project' | 'shared', world: CandidateWorld): Promise<Candidate> {
  const disk = world.disk ?? realDisk
  const what = kind === 'project' ? 'a project' : 'a shared folder'
  const fold = (value: string): string => (world.caseInsensitive ? value.toLowerCase() : value)
  const inside = (root: string, target: string): boolean => contains(fold(root), fold(target))
  const same = (a: string, b: string): boolean => fold(a) === fold(b)

  let real: string
  try {
    real = trimTrailing(await disk.realpath(path))
  } catch {
    return { ok: false, reason: `${path} does not exist` }
  }
  let isFolder: boolean
  try {
    isFolder = await disk.isDirectory(real)
  } catch {
    isFolder = false
  }
  if (!isFolder) return { ok: false, reason: `${path} is not a folder` }

  if (real === sep) return { ok: false, reason: `the root of the disk cannot be ${what}` }
  if (same(real, await canonicalPath(world.home, disk))) return { ok: false, reason: `your home folder cannot be ${what}` }

  for (const [root, name] of [
    [world.factotumRoot, "factotum's own state"],
    [world.installRoot, 'the checkout factotum runs from'],
  ] as const) {
    if (root === undefined) continue
    const canonical = await canonicalPath(root, disk)
    if (inside(canonical, real) || inside(real, canonical)) {
      return { ok: false, reason: `${path} is, holds or sits inside ${name} (${canonical})` }
    }
  }

  if (kind === 'shared') {
    for (const shared of world.shared) {
      if (same(await canonicalPath(shared, disk), real)) return { ok: false, reason: `${path} is already shared` }
    }
    return { ok: true, realPath: real, base: basename(real) }
  }

  for (const project of world.projects) {
    const canonical = await canonicalPath(project.path, disk)
    if (same(canonical, real)) return { ok: false, reason: `${path} is already the project "${project.id}"` }
    if (inside(canonical, real)) return { ok: false, reason: `${path} is inside the project "${project.id}"` }
    if (inside(real, canonical)) return { ok: false, reason: `${path} contains the project "${project.id}"` }
  }
  return { ok: true, realPath: real, base: basename(real) }
}
