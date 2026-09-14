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
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
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
 * THE FORM IS VALIDATED AT STEP 6, BY THE MODULE'S SCHEMA. This is the other half and
 * it is I/O, so it only ever runs from `start()` — step 12, inside the registry's
 * try/catch. Called from `routes()` it would take the daemon down with a raw stack.
 *
 * It THROWS rather than degrading per-site: a site that was declared and is not there
 * is a configuration error about the permission boundary, and quietly running with one
 * fewer site would be quietly running with a boundary the owner did not write.
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
