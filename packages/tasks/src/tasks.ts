/**
 * The facade (design D2): what the module calls, and the only door to the board.
 *
 * EVERY INPUT FROM OUTSIDE ARRIVES AS `unknown` and is shaped here (`shape.ts`) before an op sees it,
 * so the `400` with its field comes from one place. Every change goes through the store's queue.
 *
 * WHAT IS STILL TO COME answers «not yet»: the agent (block H). Relay mode
 * does not start: it needs block R.
 *
 * NOTHING HERE LOGS A TITLE, notes or subtasks (criterion 41): the store logs codes and the facade
 * logs nothing about a card.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { z } from 'zod'
import { uuidv7 } from '@factotum/sessions'
import { createCapturer } from './ai/capture.ts'
import { runClaude, type RunResult } from './ai/run.ts'
import { createNext } from './ai/next.ts'
import { captureOutputSchema, CAPTURE_JSON_SCHEMA, NEXT_JSON_SCHEMA, nextOutputSchema } from './ai/schema.ts'
import { acceptTask, closeCycles, createTask, linkSession, moveTask, patchTask, removeTask, type Changed, type OpContext } from './board/ops.ts'
import { openBoardStore } from './board/store.ts'
import { boardView, cycleSummaries } from './board/view.ts'
import { parseTasksConfig } from './config.ts'
import { parseAccept, parseCapture, parseClose, parseLink, parseMove, parseNewTask, parsePatch, type Shaped } from './shape.ts'
import type { AgentToolImpl, Board, CreateTasksResult, Result, Task, Tasks, TasksDeps } from './types.ts'

/** A capture is read within this, or it is `failed` and keeps its text (criterion 22). */
export const PARSE_TIMEOUT_MS = 30_000
/** «What's next?» answers within this (criterion 38). */
export const NEXT_TIMEOUT_MS = 60_000


const SECOND_CUT_AGENT: AgentToolImpl = {
  tools: () => [],
  call: async () => ({ content: [{ type: 'text', text: 'Creating tasks is not available on this board yet.' }], isError: true }),
}

function invalid<T>(shaped: Shaped<unknown> & { readonly ok: false }): Result<T> {
  return { ok: false, error: { code: 'invalid', field: shaped.field, reason: shaped.reason } }
}

function cardOf(result: Result<Changed>): Result<Task> {
  return result.ok ? { ok: true, value: result.value.task } : result
}

export async function createTasks(deps: TasksDeps): Promise<CreateTasksResult> {
  const parsed = parseTasksConfig(deps.config)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  if (parsed.config.mode === 'relay') {
    return { ok: false, reason: 'relay mode is not available yet: it forwards to the board host and arrives with block R' }
  }
  const timeZone = parsed.timeZone

  const opened = await openBoardStore({ dir: deps.stateDir, timeZone, now: deps.now(), log: deps.log })
  if (!opened.ok) return { ok: false, reason: opened.reason }
  const store = opened.store

  const opContext = (): OpContext => {
    const now = deps.now()
    return { now, timeZone, newId: () => uuidv7(now.getTime()) }
  }

  // `claude` runs in an empty folder of its own: nobody's project, nothing for it to read.
  const runDir = join(deps.stateDir, 'run')
  try {
    await mkdir(runDir, { recursive: true, mode: 0o700 })
  } catch (error) {
    return { ok: false, reason: `the folder claude runs in could not be prepared (${error instanceof Error && 'code' in error ? String(error.code) : 'unknown'})` }
  }
  const { model, effort } = parsed.config
  /** One kind of run: its schema, both ways, and its timeout. Everything else is the board's. */
  const runner =
    <T>(jsonSchema: string, output: z.ZodType<T>, timeoutMs: number) =>
    (prompt: string, signal: AbortSignal): Promise<RunResult<T>> =>
      runClaude({
        prompt,
        jsonSchema,
        output,
        model,
        effort,
        cwd: runDir,
        timers: deps.timers,
        signal,
        timeoutMs,
        ...(deps.claudeBin === undefined ? {} : { bin: deps.claudeBin }),
      })
  const capturer = createCapturer({ store, opContext, log: deps.log, run: runner(CAPTURE_JSON_SCHEMA, captureOutputSchema, PARSE_TIMEOUT_MS) })
  const nexter = createNext({ store, opContext, log: deps.log, run: runner(NEXT_JSON_SCHEMA, nextOutputSchema, NEXT_TIMEOUT_MS) })

  /** Shape the input, then run the op on the board of that moment. */
  const shaped =
    <I>(parse: (raw: unknown) => Shaped<I>, op: (input: I) => (board: Board) => Result<Changed>) =>
    async (raw: unknown): Promise<Result<Task>> => {
      const input = parse(raw)
      if (!input.ok) return invalid(input)
      return cardOf(await store.change(op(input.value)))
    }

  const tasks: Tasks = {
    board: (filter) => boardView(store.current(), deps.now(), timeZone, filter),

    get: (id) => {
      const board = store.current()
      const live = board.tasks.find((t) => t.id === id)
      if (live !== undefined) return live
      for (const cycle of board.cycles) {
        const archived = cycle.done.find((t) => t.id === id) ?? cycle.canceled.find((t) => t.id === id)
        if (archived !== undefined) return archived
      }
      return undefined
    },

    create: shaped(parseNewTask, (input) => (board) => createTask(board, input, opContext())),
    patch: (id, raw) => shaped(parsePatch, (input) => (board) => patchTask(board, id, input, opContext()))(raw),
    move: (id, raw) => shaped(parseMove, (input) => (board) => moveTask(board, id, input, opContext()))(raw),
    accept: (id, raw) => shaped(parseAccept, (to) => (board) => acceptTask(board, id, to, opContext()))(raw),
    linkSession: (id, raw) => shaped(parseLink, (link) => (board) => linkSession(board, id, link, opContext()))(raw),

    remove: async (id) => {
      const result = await store.change((board) => removeTask(board, id))
      return result.ok ? { ok: true, value: { id } } : result
    },

    closeCycles: async (raw) => {
      const input = parseClose(raw)
      if (!input.ok) return invalid(input)
      const result = await store.change((board) => closeCycles(board, input.value, opContext()))
      return result.ok ? { ok: true, value: result.value.closed } : result
    },

    cycles: () => cycleSummaries(store.current()),
    cycle: (id) => store.current().cycles.find((c) => c.id === id),
    // UUIDv7: by id is by creation, oldest first.
    triage: () => store.current().tasks.filter((t) => t.status === 'triage').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),

    capture: async (raw) => {
      const input = parseCapture(raw)
      return input.ok ? capturer.capture(input.value) : invalid(input)
    },
    runNext: () => nexter.start(),
    nextStatus: () => nexter.status(),
    agent: SECOND_CUT_AGENT,

    stop: async () => {
      // The runs first: what they would have written is decided by the next start (criterion 23c).
      await Promise.all([capturer.stop(), nexter.stop()])
      await store.idle()
    },
  }
  return { ok: true, tasks }
}
