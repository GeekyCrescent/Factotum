/**
 * The task board, as the composition root sees it (spec 2026-10-14-tareas-kanban).
 *
 * `packages/cli` imports `createTasks` and `createTasksLink` from here and hands them to `tasksModule`.
 * Nothing in `modules/` imports this package: it declares the same shapes by hand and the two meet at
 * one assignment in `main.ts`, as the session engine and the inbox do (criterion 43).
 */

export type {
  AgentCall,
  AgentTool,
  AgentToolImpl,
  AgentToolResult,
  Board,
  BoardView,
  CloseInput,
  ClosedCycle,
  CreateTasks,
  CreateTasksResult,
  CycleId,
  CycleRange,
  CycleSummary,
  Estimate,
  Priority,
  ProjectRef,
  Result,
  SessionLink,
  Status,
  Subtask,
  Task,
  TaskError,
  TaskSource,
  Tasks,
  TasksDeps,
  TasksLink,
} from './types.ts'
export { createTasks } from './tasks.ts'
export { createTasksLink } from './link.ts'
