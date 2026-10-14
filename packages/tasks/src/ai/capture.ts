/**
 * A capture: saved now, read by claude afterwards (design D5; criteria 21–23c).
 *
 * THE CARD IS WRITTEN BEFORE CLAUDE IS ASKED. `capture` answers as soon as the card is in triage with
 * `parse: 'pending'`; the run goes on outside the request, so closing the app loses nothing.
 *
 * THE ANSWER NEVER OVERWRITES THE OWNER (criterion 23b). It lands only on a card that is still in
 * triage, still `pending`, and with the `updatedAt` it had when the run was decided — checked INSIDE
 * the store's queue, on the board of that moment. Otherwise it is thrown away, and a card still
 * `pending` becomes `skipped`, which shows nothing: nothing failed.
 *
 * THE LISTS ARE CLOSED (criterion 22): the areas are the board's, the projects are the ones the client
 * sent with this capture (S12, held in memory for this run only). An answer outside them is `null`.
 *
 * AT MOST `MAX_PARALLEL_PARSES` runs at a time; the rest wait their turn, and one the owner touched
 * while it waited is skipped without spending a run. Past `MAX_WAITING_PARSES` waiting, a capture is
 * refused before its card is written: every one is a paid run, and a client stuck in a retry loop must
 * not queue them without end.
 *
 * THE LOG CARRIES IDS, TIMES, TOKENS AND COST, never a word of the capture (criterion 41).
 */

import type { Logger } from '@factotum/core'
import { createCaptured, type OpContext } from '../board/ops.ts'
import type { BoardStore } from '../board/store.ts'
import { MAX_TITLE_CHARS, type CaptureRequest } from '../shape.ts'
import type { Board, ProjectRef, Result, Task } from '../types.ts'
import { buildCapturePrompt, todayOf, type PromptProject } from './prompt.ts'
import type { RunResult } from './run.ts'
import type { CaptureOutput } from './schema.ts'

export const MAX_PARALLEL_PARSES = 2
export const MAX_WAITING_PARSES = 20

export type CaptureInput = CaptureRequest

export interface CaptureDeps {
  readonly store: BoardStore
  readonly opContext: () => OpContext
  readonly log: Logger
  /** One run of claude over this prompt; aborted by `signal` on `stop`. Never rejects. */
  readonly run: (prompt: string, signal: AbortSignal) => Promise<RunResult<CaptureOutput>>
}

export interface Capturer {
  /** Already shaped: the facade asked `shape.ts`. */
  readonly capture: (input: CaptureInput) => Promise<Result<Task>>
  readonly stop: () => Promise<void>
}

interface Job {
  readonly id: string
  /** The card's `updatedAt` when it was written: the guard of criterion 23b. */
  readonly stamp: string
  readonly projects: readonly ProjectRef[]
  readonly prompt: PromptProject[]
}

/** Every area the board has ever used: live cards and the closed cycles' copies. */
export function areasOf(board: Board): readonly string[] {
  const all = [...board.tasks, ...board.cycles.flatMap((c) => [...c.done, ...c.canceled])]
  return [...new Set(all.flatMap((t) => (t.area === null ? [] : [t.area])))].sort()
}

function intact(card: Task | undefined, stamp: string): card is Task {
  return card !== undefined && card.status === 'triage' && card.source.kind === 'capture' && card.source.parse === 'pending' && card.updatedAt === stamp
}

function stillPending(card: Task | undefined): card is Task & { readonly source: { readonly kind: 'capture' } } {
  return card !== undefined && card.source.kind === 'capture' && card.source.parse === 'pending'
}

type Parse = 'ok' | 'failed' | 'skipped'
type Deduced = Pick<Task, 'title' | 'area' | 'project' | 'due' | 'priority'>

/** The card with its `parse` set, and the deduced fields when there are some. Pure. */
function settled(card: Task, parse: Parse, at: string, fields: Partial<Deduced> = {}): Task {
  if (card.source.kind !== 'capture') return card
  // `skipped` is bookkeeping, not an edit: the card keeps the `updatedAt` the owner gave it.
  return { ...card, ...fields, source: { ...card.source, parse }, updatedAt: parse === 'skipped' ? card.updatedAt : at }
}

const UNCHANGED: Result<{ readonly board: Board }> = { ok: false, error: { code: 'conflict', reason: 'nothing to write' } }

export function createCapturer(deps: CaptureDeps): Capturer {
  const abort = new AbortController()
  const waiting: Job[] = []
  const inFlight = new Set<Promise<void>>()
  let active = 0

  /** One write on the board of that moment, guarded; nothing at all when the guard has nothing to do. */
  const settle = (job: Job, decide: (card: Task, ctx: OpContext, board: Board) => Task | undefined) =>
    deps.store.change((board) => {
      if (abort.signal.aborted) return UNCHANGED
      const card = board.tasks.find((t) => t.id === job.id)
      if (card === undefined) return UNCHANGED
      const ctx = deps.opContext()
      const next = decide(card, ctx, board)
      if (next === undefined) return UNCHANGED
      const tasks = board.tasks.map((t) => (t.id === job.id ? next : t))
      return { ok: true, value: { board: { ...board, tasks } } }
    })

  const skipIfTouched = (job: Job) =>
    settle(job, (card, ctx) => (stillPending(card) && !intact(card, job.stamp) ? settled(card, 'skipped', ctx.now.toISOString()) : undefined))

  const apply = (job: Job, result: RunResult<CaptureOutput>, areas: readonly string[]) =>
    settle(job, (card, ctx) => {
      const at = ctx.now.toISOString()
      if (!intact(card, job.stamp)) return stillPending(card) ? settled(card, 'skipped', at) : undefined
      if (!result.ok) return settled(card, 'failed', at)
      const out = result.value
      const index = out.project === null ? -1 : job.prompt.findIndex((p) => p.id === out.project)
      return settled(card, 'ok', at, {
        title: out.title,
        area: out.area !== null && areas.includes(out.area) ? out.area : null,
        project: index >= 0 ? (job.projects[index] ?? null) : null,
        due: out.due,
        priority: out.priority,
      })
    })

  const work = async (job: Job): Promise<void> => {
    const board = deps.store.current()
    const card = board.tasks.find((t) => t.id === job.id)
    if (!intact(card, job.stamp)) {
      await skipIfTouched(job)
      return
    }
    const areas = areasOf(board)
    const ctx = deps.opContext()
    const raw = card.source.kind === 'capture' ? card.source.raw : card.title
    const prompt = buildCapturePrompt({ raw, today: todayOf(ctx.now, ctx.timeZone), areas, projects: job.prompt })
    const result = await deps.run(prompt, abort.signal)
    if (abort.signal.aborted) return
    if (result.ok) {
      const u = result.usage
      deps.log.info(`capture ${job.id} parsed in ${u.ms} ms, ${u.inputTokens} in / ${u.outputTokens} out, $${u.costUsd.toFixed(4)}`)
    } else {
      deps.log.warn(`capture ${job.id} could not be parsed: ${result.reason}`)
    }
    const written = await apply(job, result, areas)
    // `conflict` is the guard's «nothing to write»; anything else is a write that failed, and the card
    // stays `pending` until the next start settles it (criterion 23c).
    if (!written.ok && written.error.code !== 'conflict') deps.log.warn(`capture ${job.id} could not be saved: ${written.error.code}`)
  }

  const pump = (): void => {
    while (active < MAX_PARALLEL_PARSES && !abort.signal.aborted) {
      const job = waiting.shift()
      if (job === undefined) return
      active++
      const running: Promise<void> = work(job)
        .catch((error: unknown) => deps.log.error(`capture ${job.id} failed: ${error instanceof Error ? error.message : 'unknown'}`))
        .finally(() => {
          active--
          inFlight.delete(running)
          pump()
        })
      inFlight.add(running)
    }
  }

  return {
    capture: async (input) => {
      if (abort.signal.aborted) return { ok: false, error: { code: 'module-error', reason: 'the board is stopping' } }
      if (waiting.length >= MAX_WAITING_PARSES) {
        return { ok: false, error: { code: 'conflict', reason: `${MAX_WAITING_PARSES} captures are already waiting to be read; try again in a minute` } }
      }
      const created = await deps.store.change((board) => createCaptured(board, input.text, MAX_TITLE_CHARS, deps.opContext()))
      if (!created.ok) return created
      const task = created.value.task
      const projects = input.projects ?? []
      waiting.push({
        id: task.id,
        stamp: task.updatedAt,
        projects: projects.map((p) => ({ host: p.host, siteId: p.siteId })),
        prompt: projects.map((p, i) => ({ id: `p${i}`, name: p.name, siteId: p.siteId })),
      })
      pump()
      return { ok: true, value: task }
    },
    stop: async () => {
      abort.abort()
      waiting.length = 0
      await Promise.all([...inFlight])
    },
  }
}
