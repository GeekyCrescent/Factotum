/**
 * The task board's clock, MOVED IN `dev` ONLY (spec 2026-10-14-tareas-kanban, S13, design D12).
 *
 * Closing a cycle happens on Monday, and checking it by hand cannot wait for one. The kernel has no
 * clock seam (`BootOptions` carries no `now`), and adding one there would touch `packages/kernel`
 * (criterion 42). So, with the shape of `ask-timeout.ts`, `FACTOTUM_TASKS_NOW_OFFSET_DAYS` moves the
 * clock of `tasks` alone — in `dev`. In `prod` it is ignored, and said, so a variable left in a shell
 * profile cannot quietly close the owner's week early.
 */

export const TASKS_NOW_VARIABLE = 'FACTOTUM_TASKS_NOW_OFFSET_DAYS'
/** Further than this is not testing a week; it is a typo. */
export const MAX_OFFSET_DAYS = 366

const DAY_MS = 24 * 60 * 60 * 1000

/** Milliseconds to add to `ctx.now()` for `tasks`: 0 unless dev asked for something sensible. */
export function tasksNowOffset(env: string, vars: Readonly<Record<string, string | undefined>>, warn: (message: string) => void): number {
  const raw = vars[TASKS_NOW_VARIABLE]
  if (raw === undefined) return 0
  if (env !== 'dev') {
    warn(`${TASKS_NOW_VARIABLE} is only read in dev; ignored in ${env}`)
    return 0
  }
  const days = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isInteger(days) || Math.abs(days) > MAX_OFFSET_DAYS) {
    warn(`${TASKS_NOW_VARIABLE}=${raw} ignored: it takes whole days from -${MAX_OFFSET_DAYS} to ${MAX_OFFSET_DAYS}`)
    return 0
  }
  return days * DAY_MS
}
