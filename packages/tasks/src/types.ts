/**
 * The shapes of the board (spec 2026-10-14-tareas-kanban, design D2).
 *
 * `modules/tasks/types.ts` declares these AGAIN, by hand: a module cannot import this package
 * (CLAUDE.md §1). The two meet at one assignment in `packages/cli/src/main.ts`, where the compiler
 * checks that the factory fits — the fourth place with this arrangement (ADR-0005, ADR-0018).
 *
 * MEMBERS ARE FUNCTION-TYPED PROPERTIES, never method syntax: a method's parameter is bivariant, and
 * the assignment in `main.ts` would stop catching an argument that changes shape.
 */

import type { Logger, Notifier, PeerCaller, Timers } from '@factotum/core'

export const STATUSES = ['triage', 'backlog', 'todo', 'in_progress', 'blocked', 'done', 'canceled'] as const
export type Status = (typeof STATUSES)[number]

/** None, Urgent, High, Medium, Low — as Linear. */
export type Priority = 0 | 1 | 2 | 3 | 4
export type Estimate = 1 | 2 | 3 | 5 | 8

/** `YYYY-Www`, the week ALWAYS with two digits. Compared only with `compareCycles`, never as text. */
export type CycleId = string

/**
 * `host: null` IS THE BOARD'S HOST; a name is another host. Never "the host serving the app" —
 * that is the client's `undefined`, and the two meet in one place (design D9, «Qué host es null»).
 */
export interface ProjectRef {
  readonly host: string | null
  readonly siteId: string
}

export interface Subtask {
  readonly id: string
  readonly text: string
  readonly done: boolean
}

export type TaskSource =
  | { readonly kind: 'owner' }
  /** `skipped`: the guard of criterion 23b threw the result away. It shows nothing. */
  | { readonly kind: 'capture'; readonly raw: string; readonly parse: 'pending' | 'ok' | 'failed' | 'skipped' }
  | { readonly kind: 'agent'; readonly host: string | null; readonly sessionId: string; readonly siteId: string }

export interface SessionLink {
  readonly host: string | null
  readonly sessionId: string
  readonly at: string
}

export interface Task {
  /** UUIDv7, like the sessions: sorting by id is sorting by creation. */
  readonly id: string
  readonly title: string
  readonly notes: string
  readonly status: Status
  /** The key that orders the card inside its column (`board/order.ts`). */
  readonly order: string
  /** `null` in `triage` and `backlog`; the cycle it is in otherwise. */
  readonly cycle: CycleId | null
  readonly area: string | null
  readonly project: ProjectRef | null
  readonly priority: Priority
  readonly labels: readonly string[]
  readonly estimate: Estimate | null
  /** `YYYY-MM-DD`. */
  readonly due: string | null
  /** ISO 8601 with its offset. */
  readonly remindAt: string | null
  readonly remindedAt: string | null
  readonly reminderMissed: boolean
  readonly subtasks: readonly Subtask[]
  readonly source: TaskSource
  readonly sessions: readonly SessionLink[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt: string | null
}

/** A closed cycle keeps COPIES of what was done and canceled in it; nothing is ever pruned (S9). */
export interface ClosedCycle {
  readonly id: CycleId
  readonly closedAt: string
  readonly done: readonly Task[]
  readonly canceled: readonly Task[]
  /** The ids that went on to the next cycle. */
  readonly carried: readonly string[]
}

/** The last answer of «What's next?» (design D5). Written by the second cut; carried from day one. */
export interface NextResult {
  readonly at: string
  readonly items: readonly { readonly id: string; readonly why: string }[]
  readonly note: string
}

export interface Board {
  readonly version: 1
  /** A copy of the config's, so a change can be noticed and logged (design D4). */
  readonly timeZone: string
  /** The last cycle opened and not closed. */
  readonly openCycle: CycleId
  readonly tasks: readonly Task[]
  readonly cycles: readonly ClosedCycle[]
  /** sessionId → cards created (criterion 27). */
  readonly agentCounts: Readonly<Record<string, number>>
  readonly next: NextResult | null
}

/** Monday and Sunday of a cycle, `YYYY-MM-DD`. */
export interface CycleRange {
  readonly start: string
  readonly end: string
}

/** What `GET /board` answers (design D3, `view.ts`). */
export interface BoardView {
  readonly timeZone: string
  readonly openCycle: CycleId
  readonly openRange: CycleRange
  readonly currentCycle: CycleId
  /** `compareCycles(currentCycle, openCycle) > 0`: the sheet «Close W42» opens (criterion 15). */
  readonly needsClose: boolean
  /** The backlog and the cards of the open cycle. Never triage, never a closed cycle. */
  readonly tasks: readonly Task[]
  readonly triage: number
  readonly areas: readonly string[]
  readonly labels: readonly string[]
  readonly projects: readonly ProjectRef[]
}

export interface CycleSummary {
  readonly id: CycleId
  readonly range: CycleRange
  readonly closedAt: string
  readonly done: number
  readonly canceled: number
  readonly carried: number
}

/** A field that failed a limit, and why — what the `400` carries (criterion 10). */
export interface FieldError {
  readonly field: string
  readonly reason: string
}

export type TaskError =
  | { readonly code: 'invalid'; readonly field: string; readonly reason: string }
  | { readonly code: 'not-found'; readonly reason: string }
  | { readonly code: 'conflict'; readonly reason: string }
  /** The write failed: memory and disk are as they were. */
  | { readonly code: 'module-error'; readonly reason: string }
  /** A member of the second cut (design §15): answered, never thrown. */
  | { readonly code: 'not-yet'; readonly reason: string }

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: TaskError }

/** What the owner creates by hand: straight to a column, no AI (criterion 9). */
export interface NewTask {
  readonly title: string
  readonly status: 'backlog' | 'todo'
  readonly notes?: string
  readonly area?: string | null
  readonly project?: ProjectRef | null
  readonly priority?: Priority
  readonly labels?: readonly string[]
  readonly estimate?: Estimate | null
  readonly due?: string | null
  readonly remindAt?: string | null
  readonly subtasks?: readonly SubtaskInput[]
}

/** A subtask without `id` is new; with one, it is the same subtask edited. */
export interface SubtaskInput {
  readonly id?: string
  readonly text: string
  readonly done?: boolean
}

/** Every field optional; the status changes through `move`, never here. */
export interface TaskPatch {
  readonly title?: string
  readonly notes?: string
  readonly area?: string | null
  readonly project?: ProjectRef | null
  readonly priority?: Priority
  readonly labels?: readonly string[]
  readonly estimate?: Estimate | null
  readonly due?: string | null
  readonly remindAt?: string | null
  readonly subtasks?: readonly SubtaskInput[]
}

/** `before`: the card this one goes in front of. `after`: the one it follows. Neither: the end. */
export interface MoveInput {
  readonly status: Status
  readonly before?: string
  readonly after?: string
}

export type CloseMove = 'next' | 'backlog'

export interface CloseInput {
  /** Must be the board's `openCycle`, or the close is a `409` (criterion 17). */
  readonly from: CycleId
  /** A card left out goes to `next`: by default nothing is lost (criterion 16). */
  readonly moves?: Readonly<Record<string, CloseMove>>
}

export interface LinkInput {
  readonly host: string | null
  readonly sessionId: string
}

/** What `create_task` looks like in `tools/list` — the same shape as the sessions MCP's `McpTool`. */
export interface AgentTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
}

/** The same shape as the sessions MCP's `ToolResult`. */
export interface AgentToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly isError?: true
}

export interface AgentCall {
  readonly sessionId: string
  readonly siteId: string
  readonly toolUseId: string | undefined
  readonly name: string
  readonly raw: unknown
}

/** What the link is filled with (design D1, D8). Empty in the first cut: `tools()` is `[]`. */
export interface AgentToolImpl {
  readonly tools: () => readonly AgentTool[]
  readonly call: (input: AgentCall) => Promise<AgentToolResult>
}

/**
 * The link the composition root hands to `sessions` and to `tasks` (design D1). `family` is read on
 * every `tools/list`; `tasks` fills it LAST in `start` and clears it in `stop`.
 */
export interface TasksLink {
  readonly family: AgentToolImpl
  readonly fill: (impl: AgentToolImpl) => void
  readonly clear: () => void
}

/** Where «What's next?» stands (criteria 38–40): running, the last answer kept, and why the last run failed. */
export interface NextStatus {
  readonly running: boolean
  readonly last: NextResult | null
  readonly error: string | null
}

export interface Tasks {
  readonly board: (filter?: { readonly cycle?: CycleId }) => BoardView
  /** Also a card of a closed cycle. */
  readonly get: (id: string) => Task | undefined
  readonly create: (input: unknown) => Promise<Result<Task>>
  readonly patch: (id: string, patch: unknown) => Promise<Result<Task>>
  readonly move: (id: string, to: unknown) => Promise<Result<Task>>
  readonly accept: (id: string, to: unknown) => Promise<Result<Task>>
  readonly remove: (id: string) => Promise<Result<{ readonly id: string }>>
  readonly linkSession: (id: string, link: unknown) => Promise<Result<Task>>
  readonly closeCycles: (input: unknown) => Promise<Result<readonly ClosedCycle[]>>
  readonly cycles: () => readonly CycleSummary[]
  readonly cycle: (id: string) => ClosedCycle | undefined
  /** The cards in triage, oldest first. Not a column: they never show on the board (criterion 19). */
  readonly triage: () => readonly Task[]
  readonly capture: (input: unknown) => Promise<Result<Task>>
  readonly runNext: () => Result<{ readonly started: true }>
  readonly nextStatus: () => NextStatus
  readonly agent: AgentToolImpl
  /** Where the board lives, for `GET /where` (crit. 29b): here. */
  readonly where: () => WhereView
  /** `POST /agent-tasks`: a `create_task` the relay of the other host forwarded (design D8; S11). */
  readonly fromPeer: (raw: unknown) => Promise<AgentToolResult>
  readonly stop: () => Promise<void>
}

/** `GET /where` (crit. 29b): this host keeps the board, or relays to the one that does. */
export type WhereView = { readonly mode: 'board' } | { readonly mode: 'relay'; readonly host: string }

/** A host in relay mode (the Mac): no board, where the board is, and `create_task` forwarded (block R). */
export interface Relay {
  readonly where: () => WhereView
  readonly agent: AgentToolImpl
  readonly stop: () => Promise<void>
}

export interface TasksDeps {
  /** RAW: the module carries it as `z.unknown()`; the one schema lives here (design D12). */
  readonly config: unknown
  readonly stateDir: string
  readonly log: Logger
  /** Already shifted by the dev-only knob, when it is set (S13). */
  readonly now: () => Date
  readonly timers: Timers
  readonly notify: Notifier
  /** The seam for the tests' fake CLI. Never from the configuration; `CLAUDE_BIN` without it. */
  readonly claudeBin?: string
  /** `ctx.peers` (block R): the relay forwards through it, and the board names the peer it heard from. */
  readonly peers?: PeerCaller
}

export type CreateTasksResult =
  | { readonly ok: true; readonly tasks: Tasks }
  | { readonly ok: true; readonly relay: Relay }
  | { readonly ok: false; readonly reason: string }

export type CreateTasks = (deps: TasksDeps) => Promise<CreateTasksResult>
