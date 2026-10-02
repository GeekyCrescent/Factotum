/**
 * A service's output, on disk and nowhere else (spec 2026-10-02-servicios-en-segundo-plano, D4).
 *
 * THE OUTPUT IS THE DISK'S, NOT THE LOG'S (guardrail 3). It lives in `<sessionDir>/services/<id>.log`, so
 * deleting the session takes it along (criterion 22), and nothing here ever writes a byte of it anywhere
 * else — not even in a warning (criterion 30).
 *
 * TWO FILES AT MOST. Past `MAX_OUTPUT_BYTES` the current file becomes `<id>.log.1`, overwriting the one
 * before, and a fresh one starts (criterion 29). A chatty service costs 2 MiB, never the disk.
 *
 * NEVER THROWS, AND STOPS AT THE FIRST FAILURE (criterion 41). The writes are chained and every link
 * catches its own error: a directory deleted under a live service, or a full disk, leaves ONE warning
 * with the service's id and the writes after it are dropped. The service keeps running.
 */

import { mkdir, open, readFile, rename, type FileHandle } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { Logger } from '@factotum/core'
import { clipUnits } from '../questions/shape.ts'
import { MAX_LINE_CHARS } from './shape.ts'

export const MAX_OUTPUT_BYTES = 1_048_576

export interface OutputFile {
  /** Never throws. The first failure is warned (without content) and every later write is dropped. */
  readonly write: (chunk: Buffer) => void
  /** Resolves when everything written so far is on disk. A process that just exited: drained → flush → tail. */
  readonly flush: () => Promise<void>
  readonly close: () => Promise<void>
}

/** `maxBytes` is a seam: a test cannot write a mebibyte to see a rotation. */
export function openOutput(path: string, log: Logger, maxBytes: number = MAX_OUTPUT_BYTES): OutputFile {
  const id = basename(path, '.log')
  let handle: FileHandle | undefined
  let written = 0
  let broken = false

  const openFresh = async (): Promise<FileHandle> => await open(path, 'a', 0o600)

  let chain: Promise<void> = (async () => {
    await mkdir(dirname(path), { recursive: true })
    handle = await openFresh()
  })().catch(fail)

  function fail(error: unknown): void {
    if (broken) return
    broken = true
    // The id and the error's code: NEVER the content (criterion 30).
    const code = (error as NodeJS.ErrnoException | undefined)?.code ?? 'error'
    log.warn(`the output of service ${id} can no longer be written (${code}); the service keeps running`)
  }

  async function writeOne(chunk: Buffer): Promise<void> {
    if (broken || handle === undefined) return
    if (written > 0 && written + chunk.length > maxBytes) {
      await handle.close()
      handle = undefined
      await rename(path, `${path}.1`)
      handle = await openFresh()
      written = 0
    }
    await handle.write(chunk)
    written += chunk.length
  }

  return {
    write: (chunk) => {
      chain = chain.then(() => writeOne(chunk)).catch(fail)
    },
    flush: async () => await chain,
    close: async () => {
      chain = chain
        .then(async () => {
          const last = handle
          handle = undefined
          await last?.close()
        })
        .catch(() => undefined)
      await chain
    },
  }
}

/** CSI sequences (colours, cursor) and OSC sequences (window titles). Stripped when READ, never when written. */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

async function linesOf(path: string): Promise<readonly string[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * The last `lines` lines, crossing into `.1` when the current file has too few. `[]` when neither exists.
 *
 * Each file is read whole, which the rotation bounds: two files of `MAX_OUTPUT_BYTES` at most.
 */
export async function tail(path: string, lines: number): Promise<readonly string[]> {
  const current = await linesOf(path)
  const all = current.length >= lines ? current : [...(await linesOf(`${path}.1`)), ...current]
  return all.slice(-lines).map((line) => clipUnits(line.replace(ANSI, '').replace(/\r$/, ''), MAX_LINE_CHARS))
}
