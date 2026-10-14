/**
 * The board on disk: one file, read once, held in memory, every change through one queue (design D3).
 *
 * A CHANGE IS AN OP, NOT A BOARD. `change(op)` runs `op` on the board OF THAT MOMENT, inside the
 * queue, so two changes that arrive together never both start from the same board and one of them
 * vanish (criterion 6). This is the rule of `packages/sessions/src/store.ts`: nothing public waits on
 * anything public.
 *
 * MEMORY CHANGES ONLY AFTER THE DISK DID. The op returns a new board (`ops.ts` never touches its
 * input); the store writes it — temporary file, then `rename`, so a reader sees the old file or the
 * new one and never half of either — and only then swaps it in. A write that fails leaves both as
 * they were and answers `module-error`.
 *
 * A DAMAGED FILE IS NEVER OVERWRITTEN (criterion 3). It is the only copy: there is no backup
 * (requirements §2). It is copied to `board.json.bad-<date>` and the store refuses to open, which
 * switches off `tasks` alone.
 */

import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from '@factotum/core'
import type { Board, Result, Task } from '../types.ts'
import { emptyBoard } from './ops.ts'
import { parseBoard } from './schema.ts'

export const BOARD_FILE = 'board.json'

export interface BoardStore {
  readonly current: () => Board
  /** Runs `op` on the board of that moment, writes what it returns, and swaps it in. Never rejects. */
  readonly change: <T extends { readonly board: Board }>(op: (board: Board) => Result<T>) => Promise<Result<T>>
  /** Resolves when every change queued so far has landed. */
  readonly idle: () => Promise<void>
}

export interface OpenInput {
  readonly dir: string
  readonly timeZone: string
  readonly now: Date
  readonly log: Logger
}

export type Opened = { readonly ok: true; readonly store: BoardStore } | { readonly ok: false; readonly reason: string }

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown'
}

async function writeAtomically(file: string, board: Board): Promise<void> {
  const temp = `${file}.tmp`
  await writeFile(temp, `${JSON.stringify(board)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, file)
}

/** A run of the daemon that died mid-parse left its cards `pending`; they are `failed` now (criterion 23c). */
function settlePending(task: Task): Task {
  return task.source.kind === 'capture' && task.source.parse === 'pending' ? { ...task, source: { ...task.source, parse: 'failed' } } : task
}

type Loaded = { readonly ok: true; readonly board: Board; readonly dirty: boolean } | { readonly ok: false; readonly reason: string }

async function load(file: string, input: OpenInput): Promise<Loaded> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return { ok: true, board: emptyBoard(input.timeZone, input.now), dirty: true }
    return { ok: false, reason: `${BOARD_FILE} could not be read (${codeOf(error)})` }
  }

  let raw: unknown
  let problem: string | undefined
  try {
    raw = JSON.parse(text)
  } catch {
    problem = 'it is not JSON'
  }
  const parsed = problem === undefined ? parseBoard(raw) : undefined
  if (parsed === undefined || !parsed.ok) {
    const why = parsed === undefined ? problem : parsed.reason
    const copy = `${BOARD_FILE}.bad-${input.now.toISOString().replace(/[:.]/g, '-')}`
    try {
      await copyFile(file, join(input.dir, copy))
    } catch (error) {
      return { ok: false, reason: `${BOARD_FILE} is damaged (${why}) and could not be copied aside (${codeOf(error)}); it was left as it is` }
    }
    return { ok: false, reason: `${BOARD_FILE} is damaged (${why}); it was left as it is, with a copy in ${copy}` }
  }

  const loaded = parsed.board
  const tasks = loaded.tasks.map(settlePending)
  const settled = tasks.some((task, i) => task !== loaded.tasks[i])
  const rezoned = loaded.timeZone !== input.timeZone
  // A new zone recomputes nothing: it only shifts the next `cycleOf` (design D4).
  if (rezoned) input.log.warn(`the board was kept in ${loaded.timeZone} and the config now says ${input.timeZone}; cycles follow the config from now on`)
  return { ok: true, board: { ...loaded, tasks, timeZone: input.timeZone }, dirty: settled || rezoned }
}

export async function openBoardStore(input: OpenInput): Promise<Opened> {
  const file = join(input.dir, BOARD_FILE)
  try {
    // `mode` only applies to a folder mkdir creates, so one left by an earlier build is tightened too.
    await mkdir(input.dir, { recursive: true, mode: 0o700 })
    await chmod(input.dir, 0o700)
  } catch (error) {
    return { ok: false, reason: `the board folder could not be prepared (${codeOf(error)})` }
  }

  const loaded = await load(file, input)
  if (!loaded.ok) return loaded
  let board = loaded.board
  if (loaded.dirty) {
    try {
      await writeAtomically(file, board)
    } catch (error) {
      return { ok: false, reason: `${BOARD_FILE} could not be written (${codeOf(error)})` }
    }
  }

  let tail: Promise<unknown> = Promise.resolve()

  const change = <T extends { readonly board: Board }>(op: (current: Board) => Result<T>): Promise<Result<T>> => {
    const run = async (): Promise<Result<T>> => {
      let result: Result<T>
      try {
        result = op(board)
      } catch (error) {
        input.log.error(`a change to the board failed before writing: ${error instanceof Error ? error.message : 'unknown'}`)
        return { ok: false, error: { code: 'module-error', reason: 'the change could not be applied' } }
      }
      if (!result.ok) return result
      try {
        await writeAtomically(file, result.value.board)
      } catch (error) {
        input.log.error(`the board could not be written (${codeOf(error)})`)
        return { ok: false, error: { code: 'module-error', reason: `the board could not be written (${codeOf(error)})` } }
      }
      board = result.value.board
      return result
    }
    const next = tail.then(run)
    tail = next
    return next
  }

  return {
    ok: true,
    store: {
      current: () => board,
      change,
      idle: async () => {
        await tail
      },
    },
  }
}
