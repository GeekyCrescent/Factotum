/**
 * The shape of the capability this module consumes, DECLARED HERE AND NOWHERE ELSE IN THIS MODULE
 * (spec 2026-10-14-tareas-kanban, D1). The same arrangement as the sessions module's `types.ts`, whose
 * header explains it; this is the fourth place that uses it (ADR-0005, ADR-0018).
 *
 * Imports nothing but `@factotum/core` (CLAUDE.md §1; criterion 43). The two declarations meet at one
 * assignment in `packages/cli/src/main.ts`, which catches a member renamed or removed, or an argument
 * that changes shape — and NOT a field added on the other side, which this module would drop in
 * silence.
 *
 * MEMBERS ARE FUNCTION-TYPED PROPERTIES, never method syntax: a method's parameter is bivariant, and
 * the assignment in `main.ts` would stop catching an argument that changes shape.
 */

import type { Logger, Notifier, Timers } from '@factotum/core'

export type Status = 'triage' | 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'done' | 'canceled'
export type Priority = 0 | 1 | 2 | 3 | 4
export type Estimate = 1 | 2 | 3 | 5 | 8
export type CycleId = string

/** `YYYY-Www`, the week always with two digits. A COPY of the package's rule, for `?cycle=`. */
export const CYCLE_ID_PATTERN = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/

export interface ProjectRef {
  /** `null` is the BOARD's host (design D9). */
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
  | { readonly kind: 'capture'; readonly raw: string; readonly parse: 'pending' | 'ok' | 'failed' | 'skipped' }
  | { readonly kind: 'agent'; readonly host: string | null; readonly sessionId: string; readonly siteId: string }

export interface SessionLink {
  readonly host: string | null
  readonly sessionId: string
  readonly at: string
}

export interface Task {
  readonly id: string
  readonly title: string
  readonly notes: string
  readonly status: Status
  readonly order: string
  readonly cycle: CycleId | null
  readonly area: string | null
  readonly project: ProjectRef | null
  readonly priority: Priority
  readonly labels: readonly string[]
  readonly estimate: Estimate | null
  readonly due: string | null
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

export interface ClosedCycle {
  readonly id: CycleId
  readonly closedAt: string
  readonly done: readonly Task[]
  readonly canceled: readonly Task[]
  readonly carried: readonly string[]
}

export interface CycleRange {
  readonly start: string
  readonly end: string
}

export interface BoardView {
  readonly timeZone: string
  readonly openCycle: CycleId
  readonly openRange: CycleRange
  readonly currentCycle: CycleId
  readonly needsClose: boolean
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

export type TaskError =
  | { readonly code: 'invalid'; readonly field: string; readonly reason: string }
  | { readonly code: 'not-found'; readonly reason: string }
  | { readonly code: 'conflict'; readonly reason: string }
  | { readonly code: 'module-error'; readonly reason: string }
  | { readonly code: 'not-yet'; readonly reason: string }

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: TaskError }

export interface AgentTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
}

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

export interface AgentToolImpl {
  readonly tools: () => readonly AgentTool[]
  readonly call: (input: AgentCall) => Promise<AgentToolResult>
}

/** The link `main.ts` hands to this module and, in the second cut, to `sessions` (design D1). */
export interface TasksLink {
  readonly family: AgentToolImpl
  readonly fill: (impl: AgentToolImpl) => void
  readonly clear: () => void
}

/** The last answer of «What's next?» (design D5): real cards only, each with why. */
export interface NextResult {
  readonly at: string
  readonly items: readonly { readonly id: string; readonly why: string }[]
  readonly note: string
}

/** Where «What's next?» stands (criteria 38–40): running, the last answer kept, and why the last run failed. */
export interface NextStatus {
  readonly running: boolean
  readonly last: NextResult | null
  readonly error: string | null
}

export interface Tasks {
  readonly board: (filter?: { readonly cycle?: CycleId }) => BoardView
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
  readonly stop: () => Promise<void>
}

/** What `start` hands to the factory. The config is RAW: the one schema lives in the package. */
export interface TasksSetup {
  readonly config: unknown
  readonly stateDir: string
  readonly log: Logger
  readonly now: () => Date
  readonly timers: Timers
  readonly notify: Notifier
}

export type CreateTasksResult = { readonly ok: true; readonly tasks: Tasks } | { readonly ok: false; readonly reason: string }

export type CreateTasks = (setup: TasksSetup) => Promise<CreateTasksResult>
