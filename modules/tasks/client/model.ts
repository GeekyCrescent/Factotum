/**
 * What the board screen computes, PURE so `node --test` reaches it (design D11): the columns, the
 * filters, what a card shows, the cycle header, and where a drag lands.
 *
 * ORDER KEYS COMPARE AS PLAIN TEXT, never with `localeCompare`: they are base-62 digits in ASCII
 * order, and a locale would put `a` before `B`.
 */

import type { CycleId, CycleRange, ProjectRef, Status, Task } from '../types.ts'

export type Column = Exclude<Status, 'triage'>

export const COLUMNS: readonly { readonly status: Column; readonly label: string }[] = [
  { status: 'backlog', label: 'Backlog' },
  { status: 'todo', label: 'Todo' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
  { status: 'canceled', label: 'Canceled' },
]

export const PRIORITIES: readonly { readonly value: Task['priority']; readonly label: string }[] = [
  { value: 0, label: 'No priority' },
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
]

export const ESTIMATES: readonly Task['estimate'][] = [null, 1, 2, 3, 5, 8]

export function labelOf(status: Status): string {
  return status === 'triage' ? 'Triage' : (COLUMNS.find((c) => c.status === status)?.label ?? status)
}

function byOrder(a: Task, b: Task): number {
  return a.order < b.order ? -1 : a.order > b.order ? 1 : 0
}

export function columnsOf(tasks: readonly Task[]): Readonly<Record<Column, readonly Task[]>> {
  const of = (status: Column): readonly Task[] => tasks.filter((t) => t.status === status).sort(byOrder)
  return {
    backlog: of('backlog'),
    todo: of('todo'),
    in_progress: of('in_progress'),
    blocked: of('blocked'),
    done: of('done'),
    canceled: of('canceled'),
  }
}

// --- Filters (criterion 13) ---------------------------------------------------------------------

export interface Filter {
  readonly area?: string
  readonly label?: string
  /** `projectKey` of the project. */
  readonly project?: string
}

export function projectKey(project: ProjectRef): string {
  return `${project.host ?? ''}/${project.siteId}`
}

export function matches(task: Task, filter: Filter): boolean {
  if (filter.area !== undefined && task.area !== filter.area) return false
  if (filter.label !== undefined && !task.labels.includes(filter.label)) return false
  if (filter.project !== undefined && (task.project === null || projectKey(task.project) !== filter.project)) return false
  return true
}

/** What `localStorage` held, read without trusting it: anything odd is no filter. */
export function parseFilter(raw: string | null): Filter {
  if (raw === null || raw === '') return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  // An empty string would be a filter that hides every card while the select shows «All».
  const pick = (key: keyof Filter): Filter => (typeof record[key] === 'string' && record[key] !== '' ? { [key]: record[key] } : {})
  return { ...pick('area'), ...pick('label'), ...pick('project') }
}

export function serializeFilter(filter: Filter): string {
  return JSON.stringify(filter)
}

// --- What a card shows ----------------------------------------------------------------------

/** `YYYY-MM-DD` of `now` in the board's zone: what a due date is compared with. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function isOverdue(task: Task, today: string): boolean {
  return task.due !== null && task.due < today && task.status !== 'done' && task.status !== 'canceled'
}

/** «3/5», or nothing without subtasks (criterion 12). */
export function progressOf(task: Task): string | undefined {
  if (task.subtasks.length === 0) return undefined
  return `${task.subtasks.filter((s) => s.done).length}/${task.subtasks.length}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function dayMonth(date: string): { readonly day: number; readonly month: string } {
  return { day: Number(date.slice(8, 10)), month: MONTHS[Number(date.slice(5, 7)) - 1] ?? '' }
}

/** «W42 · 12–18 Oct», or «W44 · 26 Oct – 1 Nov» across two months. */
export function cycleTitle(id: CycleId, range: CycleRange): string {
  const start = dayMonth(range.start)
  const end = dayMonth(range.end)
  const days = start.month === end.month ? `${start.day}–${end.day} ${end.month}` : `${start.day} ${start.month} – ${end.day} ${end.month}`
  return `${id.slice(5)} · ${days}`
}

/** Short day for a due date on a card: «16 Oct». */
export function shortDay(date: string): string {
  const { day, month } = dayMonth(date)
  return `${day} ${month}`
}

export function labelsFrom(text: string): readonly string[] {
  return [...new Set(text.split(',').map((label) => label.trim()).filter((label) => label !== ''))]
}

const pad = (n: number): string => String(Math.abs(n)).padStart(2, '0')

/**
 * A `datetime-local` value as ISO with THIS DEVICE's offset, or `null` for an empty or broken one.
 * The board stores the instant; the offset only keeps it readable.
 */
export function reminderFrom(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null
  const date = new Date(local)
  if (Number.isNaN(date.getTime())) return null
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return `${local}:00${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
}

/** The other way: what a `datetime-local` input shows for a stored reminder, on this device. */
export function localInputOf(iso: string | null): string {
  if (iso === null) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// --- Where a drag lands (design D11) --------------------------------------------------------

export interface ColumnBox {
  readonly status: Column
  readonly left: number
  readonly right: number
}

export interface CardBox {
  readonly id: string
  readonly status: Column
  readonly top: number
  readonly bottom: number
}

export interface Drop {
  readonly status: Column
  /** Among the OTHER cards of that column. */
  readonly index: number
}

/** The column by `x` (the nearest, between two), the place by `y` among the cards left in it. */
export function dropAt(columns: readonly ColumnBox[], cards: readonly CardBox[], x: number, y: number, dragged: string): Drop | undefined {
  let best: ColumnBox | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const column of columns) {
    const distance = x < column.left ? column.left - x : x > column.right ? x - column.right : 0
    if (distance < bestDistance) {
      best = column
      bestDistance = distance
    }
  }
  if (best === undefined) return undefined
  const status = best.status
  const index = cards.filter((card) => card.status === status && card.id !== dragged && (card.top + card.bottom) / 2 < y).length
  return { status, index }
}

/** What `move` is told: the card it lands in front of, or the last one it follows. */
export function neighbours(ids: readonly string[], index: number): { readonly before?: string; readonly after?: string } {
  const before = ids[index]
  if (before !== undefined) return { before }
  const after = ids[ids.length - 1]
  return after === undefined ? {} : { after }
}

/** Every unfinished card of the closing cycle, `next` unless the owner sent it back (criterion 15). */
export function closeMoves(ids: readonly string[], back: ReadonlySet<string>): Readonly<Record<string, 'next' | 'backlog'>> {
  return Object.fromEntries(ids.map((id) => [id, back.has(id) ? 'backlog' : 'next']))
}

// --- The sheet: a draft of the card, and the patch of what changed (criterion 10) ------------

/** What the form holds: every field as the text of its input. */
export interface Draft {
  readonly title: string
  readonly notes: string
  readonly area: string
  /** `projectKey`, or `''` for none. */
  readonly project: string
  readonly priority: string
  /** Comma-separated. */
  readonly labels: string
  /** `''` for none. */
  readonly estimate: string
  readonly due: string
  /** A `datetime-local` value, `''` for none. */
  readonly remind: string
}

export function draftOf(task: Task): Draft {
  return {
    title: task.title,
    notes: task.notes,
    area: task.area ?? '',
    project: task.project === null ? '' : projectKey(task.project),
    priority: String(task.priority),
    labels: task.labels.join(', '),
    estimate: task.estimate === null ? '' : String(task.estimate),
    due: task.due ?? '',
    remind: localInputOf(task.remindAt),
  }
}

/** The inverse of `projectKey`: `host/siteId`, the host empty for the board's own. */
export function projectOf(key: string): ProjectRef | null {
  if (key === '') return null
  const slash = key.indexOf('/')
  const host = key.slice(0, slash)
  return { host: host === '' ? null : host, siteId: key.slice(slash + 1) }
}

/** Only what the owner changed: the daemon validates it, and a `400` names the field. */
export function patchOf(task: Task, draft: Draft): Readonly<Record<string, unknown>> {
  const patch: Record<string, unknown> = {}
  const title = draft.title.trim()
  if (title !== task.title) patch['title'] = title
  if (draft.notes !== task.notes) patch['notes'] = draft.notes
  const area = draft.area.trim() === '' ? null : draft.area.trim()
  if (area !== task.area) patch['area'] = area
  if (draft.project !== (task.project === null ? '' : projectKey(task.project))) patch['project'] = projectOf(draft.project)
  if (Number(draft.priority) !== task.priority) patch['priority'] = Number(draft.priority)
  const labels = labelsFrom(draft.labels)
  if (labels.join('\u0000') !== task.labels.join('\u0000')) patch['labels'] = labels
  const estimate = draft.estimate === '' ? null : Number(draft.estimate)
  if (estimate !== task.estimate) patch['estimate'] = estimate
  const due = draft.due === '' ? null : draft.due
  if (due !== task.due) patch['due'] = due
  if (draft.remind !== localInputOf(task.remindAt)) patch['remindAt'] = reminderFrom(draft.remind)
  return patch
}

// --- Reading a failed request STRUCTURALLY: the shell hangs `status` on a plain Error ----------

export function statusOf(cause: unknown): number | undefined {
  const status = (cause as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

// --- Subtasks, built from the card AS IT IS when the change is sent ----------------------------

type SubtaskBody = readonly { readonly id?: string; readonly text: string; readonly done: boolean }[]

export function toggledSubtasks(task: Task, id: string): SubtaskBody {
  return task.subtasks.map((s) => (s.id === id ? { ...s, done: !s.done } : s))
}

export function droppedSubtasks(task: Task, id: string): SubtaskBody {
  return task.subtasks.filter((s) => s.id !== id)
}

export function addedSubtasks(task: Task, text: string): SubtaskBody {
  return [...task.subtasks, { text, done: false }]
}

/** A drop at the place the card already holds: nothing to send. */
export function isSamePlace(ids: readonly string[], id: string, status: Column, drop: Drop): boolean {
  return drop.status === status && ids.indexOf(id) === drop.index
}

/** A path segment decoded, or `undefined` for a malformed one (`%E0%A4%A`) instead of a throw. */
export function safeDecode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}
