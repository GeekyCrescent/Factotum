/**
 * The clock of `jobs` (task G5, design D16): one interval of 60 s on `ctx.timers` — NEVER a global
 * timer — whose first round runs at once, one round at a time (a tick that comes while a round runs
 * is skipped). A task that answers a promise gets `TASK_TIMEOUT_MS` on the same timers: a hung one is
 * logged and left behind, so it cannot hold every later round — the backup included.
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
 * in `meta` and are written AFTER the effect, and only when it WHOLLY succeeded (both can be repeated
 * without harm), so a task missed while the daemon was down — or that failed, even for one CV of the
 * wave — runs in the next round:
 * - wave 2 remembers `lastWave2At` only if every `enqueueCv` went through;
 * - the copy remembers its day right after `VACUUM INTO` succeeded, before pruning (a prune that fails
 *   is logged, the day stays taken). Today's file found WITHOUT today's mark is removed and taken
 *   again: it is a copy nobody vouched for (a crash before the mark, a VACUUM INTO that died half-way),
 *   and VACUUM INTO refuses a file that exists, so keeping it would fail every round of the day.
 *   After `BACKUP_FAILURES_FLAG` failed copies in a row, `meta.backupFailing` holds when (for
 *   `health()`); the next good copy clears it.
 */

import { chmodSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger, Timers } from '@factotum/core'
import { todayIn } from './seed/by-hand.ts'
import type { Db, Queries } from './store/db.ts'
import { deleteMeta, getMeta, heldDraftsDue, setMeta } from './store/repo.ts'
import { ok, type Result } from './types.ts'

/** design D16. */
export const CLOCK_MS = 60_000
/** A task that has not settled by then is given up (logged), so it cannot hold every later round. */
export const TASK_TIMEOUT_MS = 120_000
/** design D2: the daily copies kept. */
export const BACKUP_KEEP = 7
/** After this many copies failed in a row, `meta[BACKUP_FAILING]` says so (for `health()`). */
export const BACKUP_FAILURES_FLAG = 3
/** `meta` key: when the daily copy started failing for good (ISO); absent while copies work. */
export const BACKUP_FAILING = 'backupFailing'
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
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : messageOf(error)
}

const TIMED_OUT: unique symbol = Symbol('timed out')

const addDays =(day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

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
  const forget = (key: string): void => {
    const written = db.tx((q) => {
      deleteMeta(q, key)
      return ok(undefined)
    })
    if (!written.ok) log.error(`jobs clock: ${key} was not cleared (${written.error.reason})`)
  }
  /** Daily copies that failed in a row, since the last good one (in memory: a restart starts again). */
  let failures = 0

  function wave2(): void {
    const at = now()
    const last = meta(LAST_WAVE2_AT)
    if (last !== undefined && at.getTime() - Date.parse(last) < WAVE2_EVERY_MS) return
    const lastHoldDay = addDays(todayIn(at, deps.timeZone), HOLD_LEAD_DAYS)
    const due = db.read((q) => heldDraftsDue(q, deps.seedFiles(), lastHoldDay))
    let allQueued = true
    for (const id of due) {
      const queued = db.tx((q) => deps.enqueueCv(q, id))
      if (queued.ok) continue
      allQueued = false
      log.error(`jobs clock: the wave-2 CV of ${id} was not queued (${queued.error.code}: ${queued.error.reason})`)
    }
    // A refused CV is tried again next round, not an hour later.
    if (allQueued) remember(LAST_WAVE2_AT, at.toISOString())
  }

  /** Keeps the newest `BACKUP_KEEP` copies (their names sort by day) and makes each one 0600. */
  function prune(dir: string): void {
    try {
      const copies = readdirSync(dir).filter((name) => BACKUP_NAME.test(name)).sort()
      const gone = copies.slice(0, Math.max(0, copies.length - BACKUP_KEEP))
      for (const name of gone) rmSync(join(dir, name), { force: true })
      for (const name of copies.slice(gone.length)) chmodSync(join(dir, name), 0o600)
    } catch (error) {
      log.error(`jobs clock: the old backups could not be pruned (${codeOf(error)})`)
    }
  }

  /** Counts a failed copy; at `BACKUP_FAILURES_FLAG` in a row, flags it in `meta` for `health()`. */
  function backupFailed(reason: string): void {
    log.error(`jobs clock: the daily backup failed (${reason})`)
    failures += 1
    if (failures !== BACKUP_FAILURES_FLAG) return
    log.error(`jobs clock: the daily backup has failed ${failures} times in a row`)
    remember(BACKUP_FAILING, now().toISOString())
  }

  function backup(): void {
    const day = todayIn(now(), deps.timeZone)
    if (meta(LAST_BACKUP_DAY) === day) return
    const dir = join(deps.stateDir, 'backups')
    const file = join(dir, `jobs-${day}.db`)
    // Today's file without today's mark is a copy we cannot vouch for (a crash before the mark, or a
    // VACUUM INTO that died half-way), and VACUUM INTO refuses a file that exists: it is redone.
    try {
      rmSync(file, { force: true })
    } catch (error) {
      backupFailed(`today's old copy could not be removed (${codeOf(error)})`)
      return
    }
    const copied = db.backup(file)
    if (!copied.ok) {
      backupFailed(copied.error.reason)
      return
    }
    remember(LAST_BACKUP_DAY, day)
    failures = 0
    if (meta(BACKUP_FAILING) !== undefined) forget(BACKUP_FAILING)
    prune(dir)
  }

  const tasks: readonly { readonly name: string; readonly run: () => unknown }[] = [
    { name: 'wave-2 CVs', run: wave2 },
    { name: 'pump', run: () => deps.pump() },
    { name: 'address checks', run: () => deps.prepareTick() },
    { name: 'backup', run: backup },
  ]

  /** Waits for `task` at most `TASK_TIMEOUT_MS` on the injected timers; a hung one is logged and left. */
  async function runTask(task: (typeof tasks)[number]): Promise<void> {
    const result = task.run()
    if (!(result instanceof Promise)) return
    let timer: Disposable | undefined
    const gaveUp = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = deps.timers.setTimeout(() => resolve(TIMED_OUT), TASK_TIMEOUT_MS)
    })
    try {
      const outcome: unknown = await Promise.race([result, gaveUp])
      if (outcome === TIMED_OUT) log.error(`jobs clock: ${task.name} gave no answer within ${TASK_TIMEOUT_MS / 1000} s; the round goes on without it`)
    } finally {
      timer?.[Symbol.dispose]()
    }
  }

  async function runRound(): Promise<void> {
    for (const task of tasks) {
      try {
        await runTask(task)
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
