/**
 * A promise with a ceiling, on the timers the kernel owns (CLAUDE.md §6): never the global
 * `setTimeout`, so a test can bound a check without waiting for it.
 *
 * THE WORK IS ABANDONED, NOT CANCELLED. A `stat` on a hung mount cannot be cancelled from here; it
 * keeps a libuv thread until the mount answers. That is why callers that can repeat a check (the
 * projects list, every launch) keep ONE in flight per folder instead of starting another each time
 * (`projects.ts`): a ceiling that let each poll add a stuck thread would drain the pool.
 */

import type { Timers } from '@factotum/core'

export function bounded<T>(work: Promise<T>, ms: number, timers: Timers, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = timers.setTimeout(() => resolve(onTimeout()), ms)
    work.then(
      (value) => {
        timer[Symbol.dispose]()
        resolve(value)
      },
      (error: unknown) => {
        timer[Symbol.dispose]()
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
