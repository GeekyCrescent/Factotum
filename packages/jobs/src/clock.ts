/**
 * The clock of `jobs` (task G5, design D16): one interval of 60 s on `ctx.timers` — NEVER a global
 * timer — whose first round runs at once, one round at a time (a tick that comes while a round runs
 * is skipped).
 *
 * THE TASKS OF THIS CUT, in this order each round:
 * 1. WAVE 2 (hourly, D8 step 7): the CV of every held `draft` of a file the module sends whose
 *    `holdUntil − 7 d ≤ today` in `jobs.timeZone`, each in its own `tx` through `enqueueCv`;
 * 2. THE QUEUE's pump (every round, D10);
 * 3. THE ADDRESS CHECKS of the next batch (every round, D9): N4's `prepareTick`, injected — C1 passes
 *    `() => checks.prepareTick({ batchSize: profile.batchSize })`;
 * 4. THE DAILY COPY (D2): `VACUUM INTO <stateDir>/backups/jobs-<YYYY-MM-DD>.db`, 7 kept, every copy
 *    in `backups/` (0700) made 0600 — `VACUUM INTO` writes with the umask.
 *
 * A TASK NEVER THROWS OUT OF ITS ROUND: a failure is logged and the next task runs. Their clocks live
 * in `meta` and are written AFTER the effect (both can be repeated without harm), so a task missed
 * while the daemon was down — or that failed — runs in the next round.
 */

import { chmodSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger, Timers } from '@factotum/core'
import { todayIn } from './seed/by-hand.ts'
import type { Db, Queries } from './store/db.ts'
import { getMeta, heldDraftsDue, setMeta } from './store/repo.ts'
import { ok, type Result } from './types.ts'

/** design D16. */
export const CLOCK_MS = 60_000
/** design D2: the daily copies kept. */
export const BACKUP_KEEP = 7
/** The CV of a held file is queued this many days before its `holdUntil` (D8 step 7, as the import). */
const HOLD_LEAD_DAYS = 7
const DAY_MS = 86_400_000
const WAVE2_EVERY_MS = 3_600_000

const LAST_BACKUP_DAY = 'lastBackupDay'
const LAST_WAVE2_AT = 'lastWave2At'
const BACKUP_NAME = /^jobs-\d{4}-\d{2}-\d{2}\.db$/

export interface ClockDeps {
  readonly db: Db
  readonly timers: Timers
  readonly now: () => Date
  /** `jobs.timeZone`: what «today» is. */
  readonly timeZone: string
  readonly log: Logger
  /** `<stateDir>`; the copies go to `<stateDir>/backups`. */
  readonly stateDir: string
  /** The generation queue's pump (`queue.pump`). */
  readonly pump: () => void
  /** The check queue's round (N4): how many it queued. */
  readonly prepareTick: () => number
  /** The seed's seam, the same function (`queue.enqueueCv`). */
  readonly enqueueCv: (q: Queries, applicationId: string) => Result<void>
  /** The seed files the module sends (base names, as `seed_key` has them): never a `byHand` one. */
  readonly seedFiles: () => readonly string[]
}

export interface Clock {
  /** Arms the interval and runs the first round at once. */
  readonly start: () => void
  /** Disarms it and waits for the round under way. */
  readonly stop: () => Promise<void>
  /** Resolves when no round is running. */
  readonly idle: () => Promise<void>
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

export function createClock(deps: ClockDeps): Clock {
  const { db, now, log } = deps
  let interval: Disposable | null = null
  let busy = false
  let current: Promise<void> = Promise.resolve()

  const meta = (key: string): string | undefined => db.read((q) => getMeta(q, key))
  const remember = (key: string, value: string): void => {
    const written = db.tx((q) => {
      setMeta(q, key, value)
      return ok(undefined)
    })
    if (!written.ok) log.error(`jobs clock: ${key} was not written (${written.error.reason})`)
  }

  function wave2(): void {
    const at = now()
    const last = meta(LAST_WAVE2_AT)
    if (last !== undefined && at.getTime() - Date.parse(last) < WAVE2_EVERY_MS) return
    const lastHoldDay = addDays(todayIn(at, deps.timeZone), HOLD_LEAD_DAYS)
    const due = db.read((q) => heldDraftsDue(q, deps.seedFiles(), lastHoldDay))
    for (const id of due) {
      const queued = db.tx((q) => deps.enqueueCv(q, id))
      if (!queued.ok) log.error(`jobs clock: the wave-2 CV of ${id} was not queued (${queued.error.code}: ${queued.error.reason})`)
    }
    remember(LAST_WAVE2_AT, at.toISOString())
  }

  /** Keeps the newest `BACKUP_KEEP` copies (their names sort by day) and makes each one 0600. */
  function prune(dir: string): void {
    const copies = readdirSync(dir).filter((name) => BACKUP_NAME.test(name)).sort()
    const gone = copies.slice(0, Math.max(0, copies.length - BACKUP_KEEP))
    for (const name of gone) rmSync(join(dir, name), { force: true })
    for (const name of copies.slice(gone.length)) chmodSync(join(dir, name), 0o600)
  }

  function backup(): void {
    const day = todayIn(now(), deps.timeZone)
    if (meta(LAST_BACKUP_DAY) === day) return
    const dir = join(deps.stateDir, 'backups')
    const copied = db.backup(join(dir, `jobs-${day}.db`))
    if (!copied.ok) {
      log.error(`jobs clock: the daily backup failed (${copied.error.reason})`)
      return
    }
    prune(dir)
    remember(LAST_BACKUP_DAY, day)
  }

  const tasks: readonly { readonly name: string; readonly run: () => unknown }[] = [
    { name: 'wave-2 CVs', run: wave2 },
    { name: 'pump', run: () => deps.pump() },
    { name: 'address checks', run: () => deps.prepareTick() },
    { name: 'backup', run: backup },
  ]

  async function runRound(): Promise<void> {
    for (const task of tasks) {
      try {
        await task.run()
      } catch (error) {
        log.error(`jobs clock: ${task.name} failed (${messageOf(error)})`)
      }
    }
  }

  function round(): void {
    if (busy) return
    busy = true
    current = runRound().finally(() => {
      busy = false
    })
  }

  return {
    start: () => {
      if (interval !== null) return
      interval = deps.timers.setInterval(round, CLOCK_MS)
      round()
    },
    stop: async () => {
      interval?.[Symbol.dispose]()
      interval = null
      await current
    },
    idle: () => current,
  }
}
