/**
 * The CV a send attaches (D9 step 2, revisión de E): the path comes from the store, so it is CONFINED
 * before anything opens it — its real path (symlinks and `..` resolved) must be under the real path of
 * `<stateDir>/artifacts/` plus a separator, a regular file, with a `.pdf` extension. Anything else is
 * treated as no CV at all: step 1 answers `missing-cv`, step 2 refuses with `missing-cv`.
 *
 * Step 2 READS IT HERE, into memory, and attaches those bytes (`readPdf`, D9 revisión del corte 1a):
 * what was checked is what is sent, never a path SMTP would open later, after `354`.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, sep } from 'node:path'

export const ARTIFACTS_DIR = 'artifacts'

const realpathOf = (path: string): string | null => {
  try {
    return realpathSync(path)
  } catch {
    return null // missing or unreadable: no CV, which the caller reports as `missing-cv`
  }
}

const isRegularFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The real path of the stored `path` when it is a regular `.pdf` under `<stateDir>/artifacts/`; otherwise null. */
export function confinedPdf(stateDir: string, path: string): string | null {
  const root = realpathOf(join(stateDir, ARTIFACTS_DIR))
  const real = realpathOf(isAbsolute(path) ? path : join(stateDir, path))
  if (root === null || real === null || !real.startsWith(root + sep)) return null
  if (extname(real).toLowerCase() !== '.pdf' || !isRegularFile(real)) return null
  return real
}

/** The bytes of the confined PDF (`confinedPdf`), read now; null when it is not one or cannot be read. */
export function readPdf(stateDir: string, path: string): Buffer | null {
  const real = confinedPdf(stateDir, path)
  if (real === null) return null
  try {
    return readFileSync(real)
  } catch {
    return null // gone or unreadable between the check and the read: no CV, `missing-cv`
  }
}
