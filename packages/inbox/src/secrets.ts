/**
 * Reading an app password from its file (spec 2026-10-05, D3; criterion 2; guardrail 3).
 *
 * READ AT EVERY RUN, never at startup: rotating the password does not ask for a restart, and a file
 * that is wrong fails ONE account in ONE run, with its reason, while the others still run.
 *
 * A REASON NEVER CARRIES THE CONTENT. Not a prefix, not a length — only what is wrong with the file.
 */

import { lstat, readFile } from 'node:fs/promises'

/** An app password is sixteen letters; anything near a kilobyte is not one. */
const MAX_BYTES = 1024

export type PasswordResult = { readonly ok: true; readonly password: string } | { readonly ok: false; readonly reason: string }

export async function readPassword(file: string): Promise<PasswordResult> {
  let stats
  try {
    // `lstat`, not `stat`: a symlink would let the check below read the target's mode while the
    // name in the config points somewhere nobody looked.
    stats = await lstat(file)
  } catch (error) {
    return { ok: false, reason: `password file unreadable (${codeOf(error)})` }
  }
  if (stats.isSymbolicLink()) return { ok: false, reason: 'password file is a symbolic link' }
  if (!stats.isFile()) return { ok: false, reason: 'password file is not a regular file' }
  if ((stats.mode & 0o077) !== 0) {
    return { ok: false, reason: `password file is readable by others (mode ${(stats.mode & 0o777).toString(8)}); chmod 600 it` }
  }
  if (stats.size === 0) return { ok: false, reason: 'password file is empty' }
  if (stats.size > MAX_BYTES) return { ok: false, reason: 'password file is larger than 1 KiB' }

  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    return { ok: false, reason: `password file unreadable (${codeOf(error)})` }
  }
  // Google shows an app password as four groups of four: the spaces are presentation, not password.
  const password = text.replace(/\s+/g, '')
  if (password === '') return { ok: false, reason: 'password file is empty' }
  return { ok: true, password }
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'error'
}
