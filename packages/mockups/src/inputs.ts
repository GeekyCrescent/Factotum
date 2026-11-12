/**
 * The inputs of a mockup, in its work-dir (design D7; criteria 9–11).
 *
 * The kernel wrote the bytes to `<stateDir>/.incoming/` and deletes whatever is left there when the
 * handler returns (ADR-0012), so a file is KEPT by moving it: a hard link under its free name (which
 * fails on a name already taken, so two uploads never overwrite each other), then the part removed.
 * Across disks (`EXDEV`) it is an exclusive copy instead.
 *
 * The inputs are confidential (requirements §5): nothing here logs a name or a byte of them.
 */

import { constants } from 'node:fs'
import { copyFile, link as fsLink, mkdir, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { codeOf } from './store/store.ts'
import type { IncomingFile } from './types.ts'

export const INPUTS_DIR = 'inputs'
export const PRIVATE_DIR = 'private'

export interface SavedInput {
  readonly name: string
  readonly kind: string
  readonly bytes: number
}

export interface UploadInput {
  readonly workDir: string
  readonly file: IncomingFile
  /** Already a plain file name (`uploadName`). */
  readonly name: string
  /** Real client data: `inputs/private/` (criterion 10). */
  readonly isPrivate: boolean
}

/** The seam for the tests: `link` is what fails with `EXDEV` across disks. */
export interface InputsFs {
  readonly link: (from: string, to: string) => Promise<void>
}

export function kindOf(name: string): string {
  const ext = extname(name).slice(1).toLowerCase()
  return ext === '' ? 'file' : ext
}

/** `a.pdf`, `a-2.pdf`, `a-3.pdf`… */
function candidate(name: string, n: number): string {
  if (n === 1) return name
  const ext = extname(name)
  return `${basename(name, ext)}-${n}${ext}`
}

export async function saveUpload(input: UploadInput, fs: InputsFs = { link: fsLink }): Promise<SavedInput> {
  const dir = input.isPrivate ? join(input.workDir, INPUTS_DIR, PRIVATE_DIR) : join(input.workDir, INPUTS_DIR)
  await mkdir(dir, { recursive: true })
  for (let n = 1; ; n++) {
    const name = candidate(input.name, n)
    const target = join(dir, name)
    try {
      await fs.link(input.file.path, target)
    } catch (error) {
      if (codeOf(error) === 'EEXIST') continue
      if (codeOf(error) !== 'EXDEV') throw error
      try {
        await copyFile(input.file.path, target, constants.COPYFILE_EXCL)
      } catch (copyError) {
        if (codeOf(copyError) === 'EEXIST') continue
        throw copyError
      }
    }
    await unlink(input.file.path)
    return { name, kind: kindOf(name), bytes: input.file.bytes }
  }
}

/** A written or dictated note: `inputs/notes-<n>.md`, the first free `n` (criterion 11). */
export async function saveNote(input: { readonly workDir: string; readonly text: string }): Promise<SavedInput> {
  const dir = join(input.workDir, INPUTS_DIR)
  await mkdir(dir, { recursive: true })
  const content = `${input.text}\n`
  for (let n = 1; ; n++) {
    const name = `notes-${n}.md`
    try {
      await writeFile(join(dir, name), content, { flag: 'wx' })
    } catch (error) {
      if (codeOf(error) === 'EEXIST') continue
      throw error
    }
    return { name, kind: 'note', bytes: Buffer.byteLength(input.text) }
  }
}
