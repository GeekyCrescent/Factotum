/**
 * `mockups.json`: one file, read once, held in memory, every change through one queue (design D1).
 *
 * The rules of `packages/tasks/src/board/store.ts`, for the same reasons:
 * - A CHANGE IS AN OP, NOT A FILE: `change(op)` runs `op` on the file of that moment, inside the queue.
 * - MEMORY CHANGES ONLY AFTER THE DISK DID: temporary file, fsync, `rename`, fsync the folder.
 * - A DAMAGED FILE IS NEVER OVERWRITTEN (criterion 3): copied to `mockups.json.bad-<date>`, and the
 *   store refuses to open, which switches off `mockups` alone.
 */

import { chmod, copyFile, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Logger } from '@factotum/core'
import type { MockupsFile, Result } from '../types.ts'
import { parseFile } from './schema.ts'

export const MOCKUPS_FILE = 'mockups.json'

export interface MockupsStore {
  readonly current: () => MockupsFile
  /** Runs `op` on the file of that moment, writes what it returns, and swaps it in. Never rejects. */
  readonly change: <T extends { readonly file: MockupsFile }>(op: (file: MockupsFile) => Result<T>) => Promise<Result<T>>
  /** Resolves when every change queued so far has landed. */
  readonly idle: () => Promise<void>
}

export interface OpenInput {
  readonly dir: string
  readonly now: Date
  readonly log: Logger
}

export type Opened = { readonly ok: true; readonly store: MockupsStore } | { readonly ok: false; readonly reason: string }

export function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown'
}

/** Temp, fsync, rename, fsync the folder: a power cut never leaves the only copy empty. */
export async function writeAtomically(file: string, content: string, mode = 0o600): Promise<void> {
  const temp = `${file}.tmp`
  const handle = await open(temp, 'w', mode)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, file)
  const folder = await open(dirname(file), 'r')
  try {
    await folder.sync()
  } finally {
    await folder.close()
  }
}

const EMPTY: MockupsFile = { version: 1, mockups: [] }

type Loaded = { readonly ok: true; readonly file: MockupsFile; readonly fresh: boolean } | { readonly ok: false; readonly reason: string }

async function load(path: string, input: OpenInput): Promise<Loaded> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return { ok: true, file: EMPTY, fresh: true }
    return { ok: false, reason: `${MOCKUPS_FILE} could not be read (${codeOf(error)})` }
  }
  let raw: unknown
  let problem: string | undefined
  try {
    raw = JSON.parse(text)
  } catch {
    problem = 'it is not JSON'
  }
  const parsed = problem === undefined ? parseFile(raw) : undefined
  if (parsed !== undefined && parsed.ok) return { ok: true, file: parsed.file, fresh: false }
  const why = parsed === undefined ? problem : parsed.reason
  const copy = `${MOCKUPS_FILE}.bad-${input.now.toISOString().replace(/[:.]/g, '-')}`
  try {
    await copyFile(path, join(input.dir, copy))
  } catch (error) {
    return { ok: false, reason: `${MOCKUPS_FILE} is damaged (${why}) and could not be copied aside (${codeOf(error)}); it was left as it is` }
  }
  return { ok: false, reason: `${MOCKUPS_FILE} is damaged (${why}); it was left as it is, with a copy in ${copy}` }
}

export async function openStore(input: OpenInput): Promise<Opened> {
  const path = join(input.dir, MOCKUPS_FILE)
  try {
    await mkdir(input.dir, { recursive: true, mode: 0o700 })
    await chmod(input.dir, 0o700)
  } catch (error) {
    return { ok: false, reason: `the state folder could not be prepared (${codeOf(error)})` }
  }
  const loaded = await load(path, input)
  if (!loaded.ok) return loaded
  let file = loaded.file
  if (loaded.fresh) {
    try {
      await writeAtomically(path, `${JSON.stringify(file)}\n`)
    } catch (error) {
      return { ok: false, reason: `${MOCKUPS_FILE} could not be written (${codeOf(error)})` }
    }
  }

  let tail: Promise<unknown> = Promise.resolve()
  const change = <T extends { readonly file: MockupsFile }>(op: (current: MockupsFile) => Result<T>): Promise<Result<T>> => {
    const run = async (): Promise<Result<T>> => {
      let result: Result<T>
      try {
        result = op(file)
      } catch (error) {
        input.log.error(`a change to the mockups failed before writing: ${error instanceof Error ? error.name : 'unknown'}`)
        return { ok: false, error: { code: 'module-error', reason: 'the change could not be applied' } }
      }
      if (!result.ok) return result
      try {
        await writeAtomically(path, `${JSON.stringify(result.value.file)}\n`)
      } catch (error) {
        input.log.error(`${MOCKUPS_FILE} could not be written (${codeOf(error)})`)
        return { ok: false, error: { code: 'module-error', reason: `the mockups could not be saved (${codeOf(error)})` } }
      }
      file = result.value.file
      return result
    }
    const next = tail.then(run)
    tail = next.catch(() => undefined)
    return next
  }

  return {
    ok: true,
    store: {
      current: () => file,
      change,
      idle: async () => {
        await tail
      },
    },
  }
}
