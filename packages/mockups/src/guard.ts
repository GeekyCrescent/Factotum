/**
 * The real-data guard (design D3; criterion 35): before a stage that publishes is accepted, no file
 * of `directions/` or `mockup-app/` may carry the same bytes as one of `inputs/private/`.
 *
 * SHA-256 of each private file against each candidate, skipping `node_modules`, `.next` and
 * `.vercel`; only a candidate whose size matches a private file is hashed. More than `maxFiles` or
 * `maxMs` REFUSES ("cannot verify"): it fails closed, and so does a folder it cannot read. Without
 * `inputs/private/`, there is nothing to guard.
 *
 * It catches a COPY, not a value retyped into a page (`docs/mockups.md` says so). The reason names
 * the published file, never the private one nor a byte of either (criterion 42).
 */

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { INPUTS_DIR, PRIVATE_DIR } from './inputs.ts'
import { GUARD_MAX_FILES, GUARD_MAX_MS } from './shape.ts'
import { codeOf } from './store/store.ts'

export const GUARDED_DIRS = ['directions', 'mockup-app'] as const
const SKIPPED = new Set(['node_modules', '.next', '.vercel'])

export interface GuardLimits {
  readonly maxFiles: number
  readonly maxMs: number
  /** Milliseconds; the seam for the tests. */
  readonly clock?: () => number
}

export const GUARD_LIMITS: GuardLimits = { maxFiles: GUARD_MAX_FILES, maxMs: GUARD_MAX_MS }

export type GuardResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

class CannotVerify extends Error {}

interface Walk {
  readonly limits: GuardLimits
  readonly started: number
  readonly clock: () => number
  count: number
}

function tick(walk: Walk): void {
  walk.count++
  if (walk.count > walk.limits.maxFiles) throw new CannotVerify(`more than ${walk.limits.maxFiles} files`)
  if (walk.clock() - walk.started > walk.limits.maxMs) throw new CannotVerify(`it took more than ${walk.limits.maxMs} ms`)
}

/** Every plain file under `dir` (a link to a file counts; a link to a folder is not followed). */
async function files(dir: string, walk: Walk, skip: ReadonlySet<string>): Promise<readonly string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await files(path, walk, skip)))
      continue
    }
    if (entry.isSymbolicLink()) {
      const target = await stat(path).catch(() => undefined)
      if (target === undefined || !target.isFile()) continue
    } else if (!entry.isFile()) {
      continue
    }
    tick(walk)
    found.push(path)
  }
  return found
}

const sha256 = async (path: string): Promise<string> => createHash('sha256').update(await readFile(path)).digest('hex')

/** A folder that is not there is nothing to walk; anything else that is not a folder cannot be verified. */
async function folder(path: string): Promise<boolean> {
  try {
    if ((await lstat(path)).isDirectory()) return true
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false
    throw error
  }
  throw new CannotVerify(`${path} is not a folder`)
}

export async function guard(workDir: string, limits: GuardLimits = GUARD_LIMITS): Promise<GuardResult> {
  const clock = limits.clock ?? Date.now
  const walk: Walk = { limits, started: clock(), clock, count: 0 }
  try {
    const privateDir = join(workDir, INPUTS_DIR, PRIVATE_DIR)
    if (!(await folder(privateDir))) return { ok: true }
    const secrets = new Map<number, Set<string>>()
    for (const path of await files(privateDir, walk, new Set())) {
      const { size } = await stat(path)
      if (size === 0) continue
      const hashes = secrets.get(size) ?? new Set<string>()
      hashes.add(await sha256(path))
      secrets.set(size, hashes)
    }
    if (secrets.size === 0) return { ok: true }
    for (const name of GUARDED_DIRS) {
      const dir = join(workDir, name)
      if (!(await folder(dir))) continue
      for (const path of await files(dir, walk, SKIPPED)) {
        const hashes = secrets.get((await stat(path)).size)
        if (hashes !== undefined && hashes.has(await sha256(path))) {
          return { ok: false, reason: `${relative(workDir, path)} is a copy of a real-data input. Real client data never goes into what is published: replace it with invented data of the same shape.` }
        }
      }
    }
    return { ok: true }
  } catch (error) {
    if (error instanceof CannotVerify) return { ok: false, reason: `cannot verify: ${error.message}. Nothing is published until it can.` }
    return { ok: false, reason: `cannot verify: a folder could not be read (${codeOf(error)}).` }
  }
}
