/**
 * Paths, the way the vault writes them and the way `sessions` compares them (design D7).
 *
 * The hubs say `work-dir: ~/Ferro/BWR/…` (requirements §0.7), so `~/` is the home folder; `~user` is
 * refused rather than guessed. `inside` folds case where `sessions` does (`sites.ts`, `judge`): on
 * macOS two spellings of one folder are one folder.
 */

import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { contains } from '@factotum/sessions'

/** `~` and `~/…` are under `home`; `~other` is `null`; anything else is returned as it is. */
export function expandHome(path: string, home: string): string | null {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  if (path.startsWith('~')) return null
  return path
}

/** A path below `home` written back with `~/`, as the hubs carry it; any other, absolute. */
export function underHome(path: string, home: string): string {
  return contains(home, path) && path !== home ? `~/${path.slice(home.length).replace(/^\/+/, '')}` : path
}

/** The real path; for one that does not exist yet, the real path of its parent plus its name. */
export async function real(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) return path
    return join(await real(parent), basename(path))
  }
}

/** Is `target` the same as `base`, or below it? On real paths, folding case where `sessions` does. */
export function inside(base: string, target: string, caseInsensitive: boolean): boolean {
  const fold = (value: string): string => (caseInsensitive ? value.toLowerCase() : value)
  return contains(fold(base), fold(target))
}
