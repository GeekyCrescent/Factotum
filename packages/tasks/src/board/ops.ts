/**
 * Every change to the board, as a pure function: a board in, a NEW board out (design D2, D3).
 *
 * THE RULES OF THE STATUSES LIVE HERE AND NOWHERE ELSE (design D2):
 * - `triage` and `backlog` carry `cycle: null`;
 * - the other five carry the cycle they are in; leaving `backlog` puts the card in `openCycle` —
 *   the OPEN cycle, which during a pending close is the previous one (criterion 8);
 * - `done` stamps `completedAt`, and leaving it clears it;
 * - `done` and `canceled` drop a reminder not yet sent (criterion 37);
 * - `triage` is left only by `accept`, to `backlog` or `todo`.
 *
 * NOTHING IS CHANGED IN PLACE. The store applies an op to its copy, writes the result, and only then
 * swaps it in: a write that fails leaves memory as it was, which only holds if the op never touched
 * the board it was given.
 *
 * The input arrives already shaped (`shape.ts`); what is checked here is what needs the board.
 */

import { compareCycles, cycleOf, cyclesBetween } from '../cycle.ts'
import type {
  Board,
  CloseInput,
  ClosedCycle,
  LinkInput,
  MoveInput,
  NewTask,
  Result,
  Status,
  Subtask,
  SubtaskInput,
  Task,
  TaskError,
  TaskPatch,
} from '../types.ts'
import { insertAt } from './order.ts'

/** The world an op may read: the clock, the board's zone and a source of ids. */
export interface OpContext {
  readonly now: Date
  readonly timeZone: string
  readonly newId: () => string
}

export interface Changed {
  readonly board: Board
  readonly task: Task
}

export interface Closed {
  readonly board: Board
  readonly closed: readonly ClosedCycle[]
}

const UNFINISHED: readonly Status[] = ['todo', 'in_progress', 'blocked']

function fail<T>(error: TaskError): Result<T> {
  return { ok: false, error }
}

const notFound = <T>(id: string): Result<T> => fail({ code: 'not-found', reason: `there is no card ${id} on the board` })

export function emptyBoard(timeZone: string, now: Date): Board {
  return { version: 1, timeZone, openCycle: cycleOf(now, timeZone), tasks: [], cycles: [], agentCounts: {}, next: null }
}

function byOrder(a: Task, b: Task): number {
  return a.order < b.order ? -1 : a.order > b.order ? 1 : 0
}

/** The cards of one column, in order, leaving one card out (the one being placed). */
function columnOf(tasks: readonly Task[], status: Status, without: string): readonly Task[] {
  return tasks.filter((t) => t.status === status && t.id !== without).sort(byOrder)
}

/**
 * `tasks` with `card` placed at `index` of its column: one new key, or the whole column with new
 * keys when the gap is spent (`order.ts`).
 */
function place(tasks: readonly Task[], card: Task, index: number): readonly Task[] {
  const column = columnOf(tasks, card.status, card.id)
  const keys = insertAt(
    column.map((t) => t.order),
    index,
  )
  const at = Math.min(Math.max(index, 0), column.length)
  const rekeyed = new Map<string, string>(column.map((t, i) => [t.id, keys[i < at ? i : i + 1] as string]))
  const placed: Task = { ...card, order: keys[at] as string }
  const others = tasks
    .filter((t) => t.id !== card.id)
    .map((t) => {
      const key = rekeyed.get(t.id)
      return key === undefined || key === t.order ? t : { ...t, order: key }
    })
  return [...others, placed]
}

function endOf(tasks: readonly Task[], status: Status, without: string): number {
  return columnOf(tasks, status, without).length
}

function subtasksFrom(input: readonly SubtaskInput[], newId: () => string): readonly Subtask[] {
  const seen = new Set<string>()
  return input.map((item) => {
    const id = item.id !== undefined && !seen.has(item.id) ? item.id : newId()
    seen.add(id)
    return { id, text: item.text, done: item.done ?? false }
  })
}

function withTask(board: Board, tasks: readonly Task[], id: string): Changed {
  const next: Board = { ...board, tasks }
  return { board: next, task: tasks.find((t) => t.id === id) as Task }
}

export function createTask(board: Board, input: NewTask, ctx: OpContext): Result<Changed> {
  const at = ctx.now.toISOString()
  const card: Task = {
    id: ctx.newId(),
    title: input.title,
    notes: input.notes ?? '',
    status: input.status,
    order: '',
    cycle: input.status === 'todo' ? board.openCycle : null,
    area: input.area ?? null,
    project: input.project ?? null,
    priority: input.priority ?? 0,
    labels: input.labels ?? [],
    estimate: input.estimate ?? null,
    due: input.due ?? null,
    remindAt: input.remindAt ?? null,
    remindedAt: null,
    reminderMissed: false,
    subtasks: subtasksFrom(input.subtasks ?? [], ctx.newId),
    source: { kind: 'owner' },
    sessions: [],
    createdAt: at,
    updatedAt: at,
    completedAt: null,
  }
  return { ok: true, value: withTask(board, place(board.tasks, card, endOf(board.tasks, card.status, card.id)), card.id) }
}

/**
 * A capture lands in TRIAGE, never in a column (criterion 19): the AI proposes, the owner accepts.
 * Its title is the raw text on one line, cut to fit; the whole text stays in `source.raw`.
 */
export function createCaptured(board: Board, raw: string, maxTitle: number, ctx: OpContext): Result<Changed> {
  const at = ctx.now.toISOString()
  const card: Task = {
    id: ctx.newId(),
    title: raw.replace(/\s+/g, ' ').trim().slice(0, maxTitle).trim(),
    notes: '',
    status: 'triage',
    order: '',
    cycle: null,
    area: null,
    project: null,
    priority: 0,
    labels: [],
    estimate: null,
    due: null,
    remindAt: null,
    remindedAt: null,
    reminderMissed: false,
    subtasks: [],
    source: { kind: 'capture', raw, parse: 'pending' },
    sessions: [],
    createdAt: at,
    updatedAt: at,
    completedAt: null,
  }
  return { ok: true, value: withTask(board, place(board.tasks, card, endOf(board.tasks, 'triage', card.id)), card.id) }
}

/**
 * A card an agent created (design D8; criterion 26): in TRIAGE, with its session and its project, and
 * the session's count raised in THE SAME CHANGE — so the cap of criterion 27 holds across a restart.
 * The cap itself is checked by the caller, on this same board, inside the same queue.
 */
export function createFromAgent(
  board: Board,
  input: { readonly title: string; readonly notes?: string; readonly area?: string; readonly due?: string; readonly priority?: Task['priority'] },
  source: { readonly host: string | null; readonly sessionId: string; readonly siteId: string },
  ctx: OpContext,
): Result<Changed> {
  const at = ctx.now.toISOString()
  const card: Task = {
    id: ctx.newId(),
    title: input.title,
    notes: input.notes ?? '',
    status: 'triage',
    order: '',
    cycle: null,
    area: input.area ?? null,
    // The session ran in this project, on the host it came from: the card is about it.
    project: { host: source.host, siteId: source.siteId },
    priority: input.priority ?? 0,
    labels: [],
    estimate: null,
    due: input.due ?? null,
    remindAt: null,
    remindedAt: null,
    reminderMissed: false,
    subtasks: [],
    source: { kind: 'agent', host: source.host, sessionId: source.sessionId, siteId: source.siteId },
    sessions: [],
    createdAt: at,
    updatedAt: at,
    completedAt: null,
  }
  const counted: Board = { ...board, agentCounts: { ...board.agentCounts, [source.sessionId]: (board.agentCounts[source.sessionId] ?? 0) + 1 } }
  return { ok: true, value: withTask(counted, place(board.tasks, card, endOf(board.tasks, 'triage', card.id)), card.id) }
}

export function patchTask(board: Board, id: string, patch: TaskPatch, ctx: OpContext): Result<Changed> {
  const card = board.tasks.find((t) => t.id === id)
  if (card === undefined) return notFound(id)
  const { subtasks, ...fields } = patch
  const reminderMoved = patch.remindAt !== undefined && patch.remindAt !== card.remindAt
  // A finished card does not take a new reminder: it would remind of finished work (criterion 37).
  const finished = card.status === 'done' || card.status === 'canceled'
  const next: Task = {
    ...card,
    ...fields,
    ...(subtasks === undefined ? {} : { subtasks: subtasksFrom(subtasks, ctx.newId) }),
    ...(reminderMoved ? { remindedAt: null, reminderMissed: false } : {}),
    ...(reminderMoved && finished ? { remindAt: null } : {}),
    updatedAt: ctx.now.toISOString(),
  }
  return { ok: true, value: withTask(board, board.tasks.map((t) => (t.id === id ? next : t)), id) }
}

/** What the rules of D2 make of a card that goes to `status`. Its order is placed afterwards. */
function moved(card: Task, status: Status, board: Board, ctx: OpContext): Task {
  const at = ctx.now.toISOString()
  const leavesReminder = (status === 'done' || status === 'canceled') && card.remindAt !== null && card.remindedAt === null
  return {
    ...card,
    status,
    cycle: status === 'backlog' || status === 'triage' ? null : (card.cycle ?? board.openCycle),
    completedAt: status === 'done' ? (card.status === 'done' ? card.completedAt : at) : null,
    ...(leavesReminder ? { remindAt: null } : {}),
    updatedAt: at,
  }
}

function neighbourIndex(column: readonly Task[], to: MoveInput): number | TaskError {
  if (to.before !== undefined) {
    const index = column.findIndex((t) => t.id === to.before)
    return index >= 0 ? index : { code: 'invalid', field: 'before', reason: 'is not a card of that column' }
  }
  if (to.after !== undefined) {
    const index = column.findIndex((t) => t.id === to.after)
    return index >= 0 ? index + 1 : { code: 'invalid', field: 'after', reason: 'is not a card of that column' }
  }
  return column.length
}

/** A move to another column, or inside the same one (a reorder). */
export function moveTask(board: Board, id: string, to: MoveInput, ctx: OpContext): Result<Changed> {
  const card = board.tasks.find((t) => t.id === id)
  if (card === undefined) return notFound(id)
  if (card.status === 'triage') return fail({ code: 'conflict', reason: 'a card in triage is accepted, not moved' })
  // Dropped next to itself (a double-fired drop): it stays where it is.
  if (to.status === card.status && (to.before === id || to.after === id)) return { ok: true, value: { board, task: card } }
  const index = neighbourIndex(columnOf(board.tasks, to.status, id), to)
  if (typeof index !== 'number') return fail(index)
  return { ok: true, value: withTask(board, place(board.tasks, moved(card, to.status, board, ctx), index), id) }
}

export function acceptTask(board: Board, id: string, to: 'backlog' | 'todo', ctx: OpContext): Result<Changed> {
  const card = board.tasks.find((t) => t.id === id)
  if (card === undefined) return notFound(id)
  if (card.status !== 'triage') return fail({ code: 'conflict', reason: 'the card is no longer in triage' })
  const next = moved({ ...card, cycle: null }, to, board, ctx)
  return { ok: true, value: withTask(board, place(board.tasks, next, endOf(board.tasks, to, id)), id) }
}

export function removeTask(board: Board, id: string): Result<{ readonly board: Board }> {
  if (!board.tasks.some((t) => t.id === id)) return notFound(id)
  return { ok: true, value: { board: { ...board, tasks: board.tasks.filter((t) => t.id !== id) } } }
}

/** Links a session and moves the card to `in_progress`, in one change (criterion 31). */
export function linkSession(board: Board, id: string, link: LinkInput, ctx: OpContext): Result<Changed> {
  const card = board.tasks.find((t) => t.id === id)
  if (card === undefined) return notFound(id)
  if (card.status === 'triage') return fail({ code: 'conflict', reason: 'a card in triage is accepted before a session is linked' })
  const known = card.sessions.some((s) => s.sessionId === link.sessionId && s.host === link.host)
  const sessions = known ? card.sessions : [...card.sessions, { host: link.host, sessionId: link.sessionId, at: ctx.now.toISOString() }]
  const next = moved({ ...card, sessions }, 'in_progress', board, ctx)
  if (card.status === 'in_progress') return { ok: true, value: withTask(board, board.tasks.map((t) => (t.id === id ? next : t)), id) }
  return { ok: true, value: withTask(board, place(board.tasks, next, endOf(board.tasks, 'in_progress', id)), id) }
}

/**
 * Closes every cycle from `openCycle` up to the current one, in one change (design D4).
 *
 * Every card that is not in backlog or triage is in `openCycle` — that is what the rules above keep
 * true — so its done and canceled are archived in the FIRST closed cycle, and the skipped ones are
 * recorded empty. Unfinished cards go on with their status, or back to the backlog; a card with no
 * instruction goes on: by default nothing is lost (criterion 16).
 *
 * An instruction for a card that is no longer unfinished (moved to Done in another tab) is ignored:
 * it has nothing left to say.
 */
export function closeCycles(board: Board, input: CloseInput, ctx: OpContext): Result<Closed> {
  if (input.from !== board.openCycle) return fail({ code: 'conflict', reason: `the open cycle is ${board.openCycle}` })
  const current = cycleOf(ctx.now, ctx.timeZone)
  if (compareCycles(current, board.openCycle) <= 0) return fail({ code: 'conflict', reason: `${board.openCycle} is still the current cycle` })

  const at = ctx.now.toISOString()
  const moves = input.moves ?? {}
  const unfinished = board.tasks.filter((t) => UNFINISHED.includes(t.status))
  const goesBack = (t: Task): boolean => moves[t.id] === 'backlog'

  const archived = (status: Status): readonly Task[] => board.tasks.filter((t) => t.status === status)
  const closed: readonly ClosedCycle[] = cyclesBetween(board.openCycle, current).map((id, i) => ({
    id,
    closedAt: at,
    done: i === 0 ? archived('done') : [],
    canceled: i === 0 ? archived('canceled') : [],
    carried: i === 0 ? unfinished.filter((t) => !goesBack(t)).map((t) => t.id) : [],
  }))

  let tasks: readonly Task[] = board.tasks
    .filter((t) => t.status !== 'done' && t.status !== 'canceled')
    .map((t) => (UNFINISHED.includes(t.status) && !goesBack(t) ? { ...t, cycle: current, updatedAt: at } : t))
  for (const card of unfinished.filter(goesBack)) {
    const back: Task = { ...card, status: 'backlog', cycle: null, updatedAt: at }
    tasks = place(tasks, back, endOf(tasks, 'backlog', card.id))
  }

  return { ok: true, value: { board: { ...board, openCycle: current, tasks, cycles: [...board.cycles, ...closed] }, closed } }
}
