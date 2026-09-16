/**
 * The state a session moves through, and the ORDER the two files are written in.
 *
 *   running → finished | failed | cancelled          (reply reopens: terminal → running)
 *
 * There is no `paused` and no `waiting-for-approval`. Pretending a session is paused
 * and resumable would be inventing state: the CLI does remember the thread through
 * `--resume`, but nothing here can claim the work was still going.
 *
 * THE WRITE ORDER, WHICH IS WHAT MAKES RECONCILIATION CORRECT:
 *
 *   LAUNCH:  take the lock   →  write meta.json `running`
 *   FINISH:  write terminal meta.json  →  release the lock
 *
 * The invariant that falls out: THE LOCK IS HELD FOR AT LEAST AS LONG AS THE SESSION
 * IS RUNNING. There is never a running session without a lock, so walking `locks/`
 * cannot miss one. And dying between the two writes — in either direction — leaves a
 * lock too many, never a session too few. It fails towards the side that can be
 * cleaned up.
 *
 * An earlier revision of the design wrote no order at all and grew a path that left a
 * site locked for ever. The order is the fix, and it is why this comment exists.
 */

import type { Logger } from '@factotum/core'
import { isAlive, type LockInfo } from './locks.ts'
import type { SessionStore } from './store.ts'
import type { SessionState } from './types.ts'

/**
 * The two lock operations reconciliation needs, as an interface rather than the class.
 *
 * `SiteLocks` satisfies it structurally. Naming the two keeps the blast radius of this
 * function honest — it walks and it releases, it never acquires — and it lets a test
 * watch the ORDER of the release against the kill, which is the one thing about this
 * function that is easy to get wrong and impossible to notice.
 */
export interface LockTable {
  readonly all: () => Promise<readonly { readonly siteId: string; readonly info: LockInfo | undefined }[]>
  readonly release: (siteId: string) => Promise<void>
}

export interface ReconcileDeps {
  readonly store: SessionStore
  readonly locks: LockTable
  readonly log: Logger
  readonly now: () => Date
  /** Injected so a test can watch the kill without owning a real process group. */
  readonly killGroup?: (pid: number) => void
  /** Injected for the same reason. */
  readonly alive?: (pid: number) => boolean
  /**
   * Tells the owner a session died with the daemon — the gap the TLS spec left written: nobody
   * told the client its session ended in a restart. FIRE AND FORGET: this runs inside `start()`,
   * bounded by MODULE_START_TIMEOUT_MS, and a slow push service must not disable the module.
   * Optional like its neighbours; the engine always passes it.
   */
  readonly announce?: (sessionId: string, siteId: string, state: SessionState, reason: string | undefined) => void
}

export const ORPHAN_REASON =
  'the agent outlived the daemon and ran with no permission gate; factotum stopped it on the way back up'

export const CRASH_REASON = 'the daemon stopped while this session was running'

/**
 * Kills a process GROUP. The negative pid is the group, not the process.
 *
 * The CLI launches its own tools, and those grandchildren outlive their parent while
 * holding the output pipe open. Killing only the child leaves them running.
 */
function killGroupDefault(pid: number): void {
  process.kill(-pid, 'SIGTERM')
}

/**
 * Startup reconciliation, walking `locks/`.
 *
 * Every row below is one row of the design's table, in its order, and the ORDER WITHIN
 * A ROW IS THE PART THAT MATTERS: for a live orphan the group is killed FIRST, the
 * session is marked second, and the lock is released LAST. Releasing first would let a
 * second agent into the same repository while the old one is still writing to it.
 */
export async function reconcile(deps: ReconcileDeps): Promise<void> {
  const alive = deps.alive ?? isAlive
  const kill = deps.killGroup ?? killGroupDefault
  const at = deps.now().toISOString()

  for (const { siteId, info } of await deps.locks.all()) {
    // ROW 1 — another daemon owns this environment. Touch NOTHING and stop.
    //
    // It should not be reachable: two daemons on one environment collide on the port
    // first. If it ever is, fighting over locks is the worst available move, so this
    // gives up loudly instead. (A pid the operating system has since handed to an
    // unrelated process would look alive here. That is the known cost of asking about
    // a pid, it is the same cost the predecessor pays, and the port is the real mutual
    // exclusion — this is a second opinion, not the mechanism.)
    if (info !== undefined && alive(info.pid)) {
      deps.log.warn(
        `lock on site "${siteId}" is held by live pid ${info.pid}; another daemon may own ` +
          'this environment, so nothing was reconciled',
      )
      return
    }

    // ROW 6 — a lock with no readable holder. Nothing can be said about a session, so
    // release and move on.
    if (info === undefined) {
      deps.log.warn(`released an unreadable lock on site "${siteId}"`)
      await deps.locks.release(siteId)
      continue
    }

    const meta = await deps.store.readMeta(info.sessionId)

    // ROWS 5 and 6 — the daemon died between taking the lock and writing the meta.
    // The directory may already exist, because `settings.json` is written first.
    if (meta === undefined) {
      deps.log.warn(
        `released the lock on site "${siteId}": session ${info.sessionId} has no readable meta.json`,
      )
      await deps.locks.release(siteId)
      continue
    }

    // ROW 4 — already terminal. The daemon died between writing the state and
    // releasing the lock. Orphan lock, nothing else to do.
    if (meta.state !== 'running') {
      await deps.locks.release(siteId)
      continue
    }

    // ROWS 2 and 3 — a session that still believes it is running.
    let reason = CRASH_REASON
    if (meta.agentPid !== undefined && alive(meta.agentPid)) {
      // ROW 2, and the order inside it is the whole point.
      try {
        kill(meta.agentPid)
        reason = ORPHAN_REASON
        deps.log.warn(`killed orphaned agent group ${meta.agentPid} for session ${info.sessionId}`)
      } catch (error) {
        // It died between the check and the signal, or it is not ours. Either way the
        // session still has to be closed and the lock still has to come back.
        deps.log.warn(`could not kill agent group ${meta.agentPid}: ${String(error)}`)
      }
    }

    await deps.store.patchMeta(info.sessionId, (current) => ({
      ...current,
      state: 'failed' as SessionState,
      endedAt: at,
      reason,
      agentPid: undefined,
    }))
    await deps.store.append(info.sessionId, { kind: 'state', state: 'failed', reason })

    // ONLY ROWS 2 AND 3 announce. Row 4 — a session already terminal — is one `stop()` closed
    // and, since the notice there comes after its patchMeta, already announced. Announcing again
    // here would be the second buzz for one end (criterion 45).
    deps.announce?.(info.sessionId, siteId, 'failed', reason)

    // LAST. Always last.
    await deps.locks.release(siteId)
  }
}
