/**
 * The facade's `stop` (design D13): the stages in order, the parts of a stage together, then the
 * store closes. IT NEVER REJECTS — the kernel awaits it once, and a second `stop()` gets the same
 * promise: a stopper that fails is logged, and the others are still awaited.
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
