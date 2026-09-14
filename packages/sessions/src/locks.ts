/**
 * One lock per SITE, taken with `O_EXCL`.
 *
 * WHY `O_EXCL` AND NOT "CHECK THEN WRITE": `open(path, 'wx')` fails in the operating
 * system's kernel when the file already exists, so there is no window between the
 * check and the write for a second launch to slip through. Two simultaneous launches
 * on one site collide somewhere this process cannot be preempted, which is the only
 * place a collision can be decided correctly.
 *
 * WHY THE PREDECESSOR'S LOCK STEALING IS NOT INHERITED. Its `acquire()` takes over any
 * lock whose `pid` is not alive, and its `reclaimOrphans()` releases them WITHOUT
 * touching `meta.json`. Two things go wrong if that is copied here:
 *
 *   - that `pid` is the DAEMON's (`pid = process.pid`), not the agent's, so it says
 *     nothing about whether an agent is still writing to the repository;
 *   - releasing a lock without updating the session leaves a second source of truth,
 *     and a session stuck at `running` for ever the moment the two disagree.
 *
 * So here the lock's pid answers exactly one question — did the previous daemon die? —
 * and `meta.json` decides everything about the session. Stealing happens in exactly
 * one place, `reconcile()`, at startup, in a written order.
 */

import { open, readFile, readdir, unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import type { SessionPaths } from './paths.ts'

export interface LockInfo {
  readonly siteId: string
  readonly sessionId: string
  /** The DAEMON's pid. The agent's lives in `meta.agentPid`. Do not confuse them. */
  readonly pid: number
  readonly acquiredAt: string
}

export type LockResult =
  | { readonly ok: true }
  /** `heldBy` is undefined when the lock file exists but cannot be read. */
  | { readonly ok: false; readonly heldBy: LockInfo | undefined }

/**
 * Does this pid exist? Signal 0 performs the permission and existence checks and
 * delivers nothing, so it asks without killing.
 *
 * `EPERM` means the process exists and belongs to somebody else — still alive.
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class SiteLocks {
  readonly #paths: SessionPaths
  readonly #pid: number

  constructor(paths: SessionPaths, pid: number = process.pid) {
    this.#paths = paths
    this.#pid = pid
  }

  async acquire(siteId: string, sessionId: string, at: string): Promise<LockResult> {
    const info: LockInfo = { siteId, sessionId, pid: this.#pid, acquiredAt: at }
    try {
      const handle = await open(this.#paths.lockFile(siteId), 'wx')
      try {
        await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`, 'utf8')
      } finally {
        await handle.close()
      }
      return { ok: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return { ok: false, heldBy: await this.heldBy(siteId) }
    }
  }

  /** Idempotent: releasing a lock nobody holds is not an error worth propagating. */
  async release(siteId: string): Promise<void> {
    try {
      await unlink(this.#paths.lockFile(siteId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async heldBy(siteId: string): Promise<LockInfo | undefined> {
    try {
      const raw = JSON.parse(await readFile(this.#paths.lockFile(siteId), 'utf8')) as Partial<LockInfo>
      if (typeof raw.sessionId !== 'string' || typeof raw.pid !== 'number') return undefined
      return {
        siteId,
        sessionId: raw.sessionId,
        pid: raw.pid,
        acquiredAt: typeof raw.acquiredAt === 'string' ? raw.acquiredAt : '',
      }
    } catch {
      return undefined
    }
  }

  /**
   * Every lock on disk.
   *
   * This is what `reconcile()` walks, and it is what bounds it: there is at most one
   * lock per declared site, so the cost is O(sites) and not O(sessions) — and sessions
   * are never deleted.
   */
  async all(): Promise<readonly { readonly siteId: string; readonly info: LockInfo | undefined }[]> {
    let names: string[]
    try {
      names = await readdir(this.#paths.locks)
    } catch {
      return []
    }

    const out: { siteId: string; info: LockInfo | undefined }[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const siteId = basename(name, '.json')
      out.push({ siteId, info: await this.heldBy(siteId) })
    }
    return out
  }
}
