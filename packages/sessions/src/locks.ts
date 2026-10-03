/**
 * A site's lock: ONE FILE PER HOLDER, under one directory per site.
 *
 *   locks/<siteId>/<holderId>.json      holderId is a session id, or `removing`
 *   locks/<siteId>.json                 THE OLD LAYOUT — read and released, never written
 *
 * WHY ONE FILE PER HOLDER (spec 2026-10-03-varias-sesiones-por-proyecto, D1, D2). A project may allow
 * several sessions at once, so a site may have several holders. The MODE is the asker's, never the
 * file's: an `exclusive` acquire loses to any holder, a `shared` one only to `removing`, to the old
 * layout, or to its own id. So turning the switch off rewrites nothing on disk — the next exclusive
 * acquire simply loses to whoever is still there.
 *
 * WHY A QUEUE IN THIS PROCESS IS ENOUGH. With one file per site, `open(path, 'wx')` decided the
 * collision in the operating system's kernel. With one file per holder, "is anyone else here?" is a
 * directory read and then a write, and another acquire fits in between. So the decision is taken
 * inside a QUEUE PER SITE, and `release` goes through the same queue, so an `rmdir` never crosses an
 * acquire. That holds because an environment has ONE daemon: the port guarantees it and row 1 of
 * `reconcile()` is the second opinion. The holder's file is still created with `'wx'`, which covers
 * the one case the queue does not see coming twice: the same holder id.
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

import { mkdir, open, readFile, readdir, rmdir, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
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

/** Who asks: `exclusive` loses to any holder, `shared` only to `removing`, the old layout or itself. */
export type LockMode = 'exclusive' | 'shared'

/** One lock on disk, in either layout. What `reconcile()` walks and releases. */
export interface LockEntry {
  readonly siteId: string
  /** `undefined` for the OLD layout, whose path names no holder. */
  readonly holderId: string | undefined
  readonly info: LockInfo | undefined
}

/** What a lock holds while its project is deleted: not a session id, so nothing mistakes it. */
export const REMOVING_HOLDER = 'removing'

const EXCLUSIVE = (): LockMode => 'exclusive'

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

/** The holders of one site as the directory has them: every id, and the readable ones by age. */
interface HolderRead {
  readonly ids: readonly string[]
  readonly byId: ReadonlyMap<string, LockInfo | undefined>
  /** Oldest first by `acquiredAt`, then by session id — a uuid v7, so the tie-break is time too. */
  readonly readable: readonly LockInfo[]
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

function byAge(a: LockInfo, b: LockInfo): number {
  if (a.acquiredAt !== b.acquiredAt) return a.acquiredAt < b.acquiredAt ? -1 : 1
  if (a.sessionId === b.sessionId) return 0
  return a.sessionId < b.sessionId ? -1 : 1
}

function parse(raw: string, siteId: string): LockInfo | undefined {
  try {
    const data = JSON.parse(raw) as Partial<LockInfo>
    if (typeof data.sessionId !== 'string' || typeof data.pid !== 'number') return undefined
    return {
      siteId,
      sessionId: data.sessionId,
      pid: data.pid,
      acquiredAt: typeof data.acquiredAt === 'string' ? data.acquiredAt : '',
    }
  } catch {
    return undefined
  }
}

/** A lock file's holder; `undefined` when it cannot be read. Never throws. */
async function readInfo(path: string, siteId: string): Promise<LockInfo | undefined> {
  try {
    return parse(await readFile(path, 'utf8'), siteId)
  } catch {
    return undefined
  }
}

/** Errors that mean "nothing to remove here", for the `rmdir` of a site's directory. */
const RMDIR_FINE = new Set(['ENOTEMPTY', 'EEXIST', 'ENOENT', 'ENOTDIR'])

export class SiteLocks {
  readonly #paths: SessionPaths
  readonly #pid: number
  readonly #queues = new Map<string, Promise<unknown>>()

  constructor(paths: SessionPaths, pid: number = process.pid) {
    this.#paths = paths
    this.#pid = pid
  }

  /**
   * `mode` is a THUNK, read INSIDE the site's queue: a launch that waited behind a toggle sees the
   * toggle (criterion 13). Never a value read before queueing.
   *
   * OPTIONAL, AND EXCLUSIVE BY DEFAULT: `acquire(site, id, at)` means exactly what it meant when a
   * site held one file, so every caller that takes a lock by hand is untouched (criterion 6b).
   */
  acquire(siteId: string, holderId: string, at: string, mode: () => LockMode = EXCLUSIVE): Promise<LockResult> {
    return this.#run(siteId, async (): Promise<LockResult> => {
      // 1. The old layout: a daemon from before the change died holding it. Both modes lose.
      const legacy = await this.#readLegacy(siteId)
      if (legacy.exists) return { ok: false, heldBy: legacy.info }

      const holders = await this.#readHolders(siteId)
      // 2. A project being deleted. Nothing comes in, whatever its mode.
      if (holders.byId.has(REMOVING_HOLDER)) return { ok: false, heldBy: holders.byId.get(REMOVING_HOLDER) }
      // 3. The same holder twice: two replies to one finished session.
      if (holders.byId.has(holderId)) return { ok: false, heldBy: holders.byId.get(holderId) }
      // 4. Exclusive loses to anyone; told the oldest READABLE one, or nobody if none can be read.
      if (mode() === 'exclusive' && holders.ids.length > 0) return { ok: false, heldBy: holders.readable[0] }

      // 5. Shared next to its siblings — an unreadable sibling is a crash's leftover, cleaned at boot.
      return await this.#write(siteId, holderId, at)
    })
  }

  /** Only this holder's file, never its siblings' (criterion 10). Idempotent. */
  release(siteId: string, holderId: string): Promise<void> {
    return this.#run(siteId, async () => {
      try {
        await unlink(this.#paths.holderFile(siteId, holderId))
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error
      }
      // Gone when it is the last one. `ENOTEMPTY` means a sibling is still there, which is the point.
      try {
        await rmdir(this.#paths.lockDir(siteId))
      } catch (error) {
        if (!RMDIR_FINE.has(codeOf(error) ?? '')) throw error
      }
    })
  }

  /** The OLD layout's file. Only `releaseEntry` reaches it, from `reconcile()`. Idempotent. */
  releaseLegacy(siteId: string): Promise<void> {
    return this.#run(siteId, async () => {
      try {
        await unlink(this.#paths.lockFile(siteId))
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error
      }
    })
  }

  /**
   * What `reconcile()` releases, by the entry's layout. A METHOD and not an adapter, so this class is
   * a `LockTable` as it stands and the tests that hand it to `reconcile` are untouched.
   */
  releaseEntry(entry: LockEntry): Promise<void> {
    return entry.holderId === undefined ? this.releaseLegacy(entry.siteId) : this.release(entry.siteId, entry.holderId)
  }

  /**
   * The OLDEST READABLE holder, in either layout, or `undefined` when there is none. The same meaning
   * it had with one file per site: the engine tests' `turnOver` polls it until `undefined`, so with N
   * holders it is `undefined` only when all N are gone. With ONLY unreadable files it is `undefined`,
   * as it always was — and `acquire` exclusive still loses to them.
   *
   * NOT QUEUED: a read, and `acquire` uses the same read from inside the queue.
   */
  async heldBy(siteId: string): Promise<LockInfo | undefined> {
    const legacy = await this.#readLegacy(siteId)
    if (legacy.info !== undefined) return legacy.info
    return (await this.#readHolders(siteId)).readable[0]
  }

  /** The holders of one site, oldest first; the unreadable ones as `undefined`, after them. Not queued. */
  async holders(siteId: string): Promise<readonly (LockInfo | undefined)[]> {
    const read = await this.#readHolders(siteId)
    const unreadable = read.ids.filter((id) => read.byId.get(id) === undefined).map(() => undefined)
    return [...read.readable, ...unreadable]
  }

  /**
   * Every lock on disk, BOTH layouts. This is what `reconcile()` walks; the cost is O(holders), which
   * is O(sessions running when the last daemon died).
   *
   * NOT QUEUED, and the `rmdir` of an empty directory here is not either. That is safe ONLY because
   * `reconcile()` calls it inside `start()`, before the engine takes any acquire. Called with the
   * engine running, it could remove a directory an acquire is creating.
   *
   * A lock may hold `removing` instead of a session id, while a project is deleted. The next boot
   * releases it like any lock whose daemon is dead: `readMeta('removing')` finds no meta, and row 5
   * lets it go.
   */
  async all(): Promise<readonly LockEntry[]> {
    let dirents
    try {
      dirents = await readdir(this.#paths.locks, { withFileTypes: true })
    } catch {
      return []
    }

    const out: LockEntry[] = []
    for (const dirent of dirents) {
      if (dirent.isFile() && dirent.name.endsWith('.json')) {
        const siteId = basename(dirent.name, '.json')
        out.push({ siteId, holderId: undefined, info: await readInfo(join(this.#paths.locks, dirent.name), siteId) })
      } else if (dirent.isDirectory()) {
        out.push(...(await this.#entriesOf(dirent.name)))
      }
    }
    return out
  }

  // --- inside -------------------------------------------------------------

  /**
   * One site's queue. A REJECTED TASK DOES NOT LEAK into the next one: a disk error in one acquire
   * must not leave the site closed until a restart (criterion 6c). The entry is deleted by IDENTITY,
   * only when nothing has queued behind it, so the map does not grow with the sites.
   */
  #run<T>(siteId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(siteId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    const tail = next.catch(() => undefined)
    this.#queues.set(siteId, tail)
    void tail.then(() => {
      if (this.#queues.get(siteId) === tail) this.#queues.delete(siteId)
    })
    return next
  }

  /** The holder's file, created with `'wx'`: the same id twice loses here even past the queue. */
  async #write(siteId: string, holderId: string, at: string): Promise<LockResult> {
    const info: LockInfo = { siteId, sessionId: holderId, pid: this.#pid, acquiredAt: at }
    await mkdir(this.#paths.lockDir(siteId), { recursive: true })
    const file = this.#paths.holderFile(siteId, holderId)
    try {
      const handle = await open(file, 'wx')
      try {
        await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`, 'utf8')
      } finally {
        await handle.close()
      }
      return { ok: true }
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error
      return { ok: false, heldBy: await readInfo(file, siteId) }
    }
  }

  /** One site directory's entries for `all()`. An empty directory is not a lock and goes. */
  async #entriesOf(siteId: string): Promise<readonly LockEntry[]> {
    const read = await this.#readHolders(siteId)
    if (read.ids.length === 0) {
      await rmdir(this.#paths.lockDir(siteId)).catch(() => undefined)
      return []
    }
    return read.ids.map((holderId) => ({ siteId, holderId, info: read.byId.get(holderId) }))
  }

  async #readLegacy(siteId: string): Promise<{ readonly exists: boolean; readonly info: LockInfo | undefined }> {
    try {
      return { exists: true, info: parse(await readFile(this.#paths.lockFile(siteId), 'utf8'), siteId) }
    } catch (error) {
      return { exists: codeOf(error) !== 'ENOENT', info: undefined }
    }
  }

  async #readHolders(siteId: string): Promise<HolderRead> {
    let names: string[]
    try {
      names = await readdir(this.#paths.lockDir(siteId))
    } catch {
      return { ids: [], byId: new Map(), readable: [] }
    }
    const byId = new Map<string, LockInfo | undefined>()
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const holderId = basename(name, '.json')
      byId.set(holderId, await readInfo(this.#paths.holderFile(siteId, holderId), siteId))
    }
    const readable = [...byId.values()].filter((info): info is LockInfo => info !== undefined).sort(byAge)
    return { ids: [...byId.keys()], byId, readable }
  }
}
