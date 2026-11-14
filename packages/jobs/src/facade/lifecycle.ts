/**
 * The facade's lifecycle (design D13): `start` runs steps 4–5 in their list's order (the clock LAST,
 * so a step that throws leaves no interval armed); `stop` runs its stages in order, the parts of a
 * stage together, then the store closes. `stop` NEVER REJECTS — the kernel awaits it once, and a
 * second `stop()` gets the same promise: a stopper that fails is logged, the others still awaited.
 *
 * THE STORE CLOSES ONLY AFTER EVERY STOPPER SETTLED, also when one rejected. That is safe because no
 * write can be half-way when `close` runs: every write is one synchronous `tx` (`node:sqlite`, one
 * thread), so between two awaits none is open. What a part that failed to stop may still try later
 * meets a closed store — `tx` answers `jobs.db is closed` and writes nothing — and the next start's
 * recovery (`recoverOnStart`) takes back whatever it left `sending`, `running` or `checking`.
 */

import type { Logger } from '@factotum/core'

export interface Part {
  readonly name: string
  readonly stop: () => Promise<void>
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Each stage after the previous one settled; then `close`. Logs every failure, never rejects. */
export async function stopInOrder(stages: readonly (readonly Part[])[], close: () => void, log: Logger): Promise<void> {
  for (const stage of stages) {
    // `part.stop()` may throw before it returns a promise: `async` turns that into a rejection too.
    const settled = await Promise.allSettled(stage.map(async (part) => part.stop()))
    settled.forEach((result, i) => {
      if (result.status === 'rejected') log.error(`jobs: ${stage[i]?.name ?? 'a part'} did not stop cleanly (${messageOf(result.reason)})`)
    })
  }
  try {
    close()
  } catch (error) {
    log.error(`jobs: jobs.db did not close cleanly (${messageOf(error)})`)
  }
}

/** Something the facade started and `stop` must wait for (an import): tracked until it settles. */
export interface InFlight {
  readonly track: <T>(running: Promise<T>) => Promise<T>
  /** Resolves when every tracked one settled; never rejects. */
  readonly settled: () => Promise<void>
}

export function inFlight(): InFlight {
  const running = new Set<Promise<unknown>>()
  return {
    track: async (promise) => {
      running.add(promise)
      try {
        return await promise
      } finally {
        running.delete(promise)
      }
    },
    settled: async () => void (await Promise.allSettled([...running])),
  }
}

export interface LifecycleDeps {
  /** Steps 4–5, in order; one that throws stops the rest (the caller then calls `stop`). */
  readonly start: readonly (() => void)[]
  readonly stop: readonly (readonly Part[])[]
  readonly close: () => void
  readonly log: Logger
}

export interface Lifecycle {
  readonly start: () => void
  /** Memoised: twice is once. */
  readonly stop: () => Promise<void>
  /** Whether `stop` was asked: the facade refuses what would write after it. */
  readonly stopping: () => boolean
}

export function lifecycle(deps: LifecycleDeps): Lifecycle {
  let stopping: Promise<void> | null = null
  return {
    start: () => {
      for (const step of deps.start) step()
    },
    stop: () => {
      stopping ??= stopInOrder(deps.stop, deps.close, deps.log)
      return stopping
    },
    stopping: () => stopping !== null,
  }
}
