/**
 * The task board, as the composition root sees it (spec 2026-10-14-tareas-kanban).
 *
 * `packages/cli` imports `createTasks` from here and hands it to `tasksModule`. Nothing in `modules/`
 * imports this package: it declares the same shapes by hand and the two meet at one assignment in
 * `main.ts`, as the session engine and the inbox do (criterion 43).
 */

export {}
