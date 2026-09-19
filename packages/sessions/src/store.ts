/**
 * `meta.json` + `events.jsonl`, one directory per session.
 *
 * TWO WRITE LAYERS, AND MIXING THEM IS A DEADLOCK. This is written down because the
 * predecessor project paid for it: it has `#aplicar()`, a read-modify-write with NO
 * queue meant for callers already running inside one, and `actualizar()`, the same
 * thing WITH the queue for callers arriving from outside. Passing something through
 * the second while already inside the first hung its runner on the first message of
 * every session.
 *
 *   - The `#…` primitives below are UNQUEUED. They assume the caller holds the turn.
 *   - Every public method takes the turn once, at the top, and then only calls
 *     primitives.
 *
 * If you add a public method, do not call another public method from it.
 *
 * DISK FIRST, MEMORY AFTER. An event is on disk before `append` resolves, so nothing
 * can observe an event that a crash would then un-happen. The other way round loses it
 * for good and no client can recover it, because the log is the only source of truth.
 */

import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { parseLog, stateFrom } from './events.ts'
import type { SessionPaths } from './paths.ts'
import type { EventInput, SessionEvent, SessionState } from './types.ts'

export interface SessionMeta {
  readonly id: string
  readonly siteId: string
  readonly entryId: string
  readonly state: SessionState
  readonly startedAt: string
  readonly endedAt: string | undefined
  readonly reason: string | undefined
  readonly turns: number
  /**
   * The process GROUP of the `claude` subprocess, as `-agentPid`.
   *
   * It does not exist in the predecessor project and it is what closes risk 18: after
   * a `kill -9` of the daemon, the agent survives — `detached: true` is both what lets
   * the group be killed and what lets it outlive its parent — and this is the only
   * record of who to kill on the way back up.
   *
   * NOT to be confused with the pid in `locks/<siteId>.json`, which is the DAEMON's.
   */
  readonly agentPid: number | undefined
  /**
   * The site's path WHEN THIS SESSION LAUNCHED.
   *
   * A site is looked up by id, and a config can move an id to another directory. Without this,
   * resuming would continue a thread whose context describes one tree, inside another — and pass
   * every check, because the id still resolves.
   *
   * `string | undefined` AND REQUIRED, not `?:`. `NewSession` is an `Omit` that does not exclude
   * it, so `create` must be handed it and the compiler says so where it is forgotten; with `?:`
   * it would compile unset and never be written. `undefined` is what a meta.json from before this
   * field reads as — it is parsed without a schema — and it means "cannot be compared".
   */
  readonly sitePath: string | undefined
  /**
   * The first prompt, cut to PROMPT_CHARS, so a list can tell five sessions in one site apart
   * without reading five logs. Same rule as `sitePath`: `string | undefined` AND REQUIRED, and
   * listed in `#readMeta` — a field missing from that list is erased by the next `patchMeta`.
   * A meta from before this field reads as `undefined`.
   */
  readonly prompt: string | undefined
}

/** Everything but the parts the store owns. */
export type NewSession = Omit<SessionMeta, 'state' | 'endedAt' | 'reason' | 'turns' | 'agentPid'>

export class SessionStore {
  readonly #paths: SessionPaths
  readonly #now: () => Date
  /** One chain per session id. Serialises writes; see the header. */
  readonly #turns = new Map<string, Promise<unknown>>()
  readonly #nextSeq = new Map<string, number>()

  constructor(paths: SessionPaths, now: () => Date) {
    this.#paths = paths
    this.#now = now
  }

  /**
   * Takes the turn for one session. A rejected body must not poison the chain for the
   * next caller, so the stored link swallows the failure while the returned one keeps
   * it.
   */
  #take<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#turns.get(id) ?? Promise.resolve()
    const next = previous.then(work, work)
    this.#turns.set(
      id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  async #writeMeta(meta: SessionMeta): Promise<void> {
    // TEMP + RENAME, and it is not belt-and-braces.
    //
    // This is the file being written in both of the mid-sequence crashes that
    // reconciliation has to survive, and a plain `writeFile` that is interrupted
    // leaves a TRUNCATED file that does not parse. `rename` within a directory is
    // atomic, so a reader sees either the old `meta.json` or the new one and never
    // half of either. The `.tmp` left behind by a crash is ignored: `listIds` only
    // looks at directories.
    const path = this.#paths.metaFile(meta.id)
    const temp = `${path}.tmp`
    await writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    await rename(temp, path)
  }

  async #readMeta(id: string): Promise<SessionMeta | undefined> {
    // NEVER THROWS, and that is a decision with a blast radius.
    //
    // `reconcile()` runs inside `start()`, and `start()` throwing disables the module.
    // A single unparseable `meta.json` would then hold EVERY lock for every site until
    // someone noticed. An unreadable session is one session nobody can report on; a
    // thrown error is every site blocked. The reconciler treats `undefined` the same
    // as "no meta at all" and releases the lock, which is the safe direction.
    try {
      const text = await readFile(this.#paths.metaFile(id), 'utf8')
      const json = JSON.parse(text) as Partial<SessionMeta>
      if (typeof json.id !== 'string' || typeof json.siteId !== 'string') return undefined
      return {
        id: json.id,
        siteId: json.siteId,
        entryId: typeof json.entryId === 'string' ? json.entryId : '',
        state: json.state ?? 'failed',
        startedAt: typeof json.startedAt === 'string' ? json.startedAt : new Date(0).toISOString(),
        endedAt: json.endedAt ?? undefined,
        reason: json.reason ?? undefined,
        turns: typeof json.turns === 'number' ? json.turns : 1,
        agentPid: typeof json.agentPid === 'number' ? json.agentPid : undefined,
        // EVERY FIELD IS LISTED BY HAND, and a field left out of this list is not just unread: it
        // is ERASED, because `patchMeta` reads through here and writes the result back. It is
        // the zod-strips-unknown-keys trap of CLAUDE.md §2 in handwritten form — and `sitePath`
        // would have fallen into it if the type had allowed it to be optional (TS2741 caught it).
        sitePath: typeof json.sitePath === 'string' ? json.sitePath : undefined,
        prompt: typeof json.prompt === 'string' ? json.prompt : undefined,
      }
    } catch {
      return undefined
    }
  }

  async #seqFor(id: string): Promise<number> {
    const known = this.#nextSeq.get(id)
    if (known !== undefined) return known
    // Derived from the file, not assumed: after a restart the log is what knows.
    const events = await this.#readEvents(id)
    const last = events.at(-1)
    const next = last === undefined ? 0 : last.seq + 1
    this.#nextSeq.set(id, next)
    return next
  }

  async #readEvents(id: string): Promise<readonly SessionEvent[]> {
    try {
      return parseLog(await readFile(this.#paths.eventsFile(id), 'utf8'))
    } catch {
      return []
    }
  }

  // --- Public surface. Each takes the turn once. ---------------------------

  async create(session: NewSession): Promise<SessionMeta> {
    return await this.#take(session.id, async () => {
      await mkdir(this.#paths.sessionDir(session.id), { recursive: true })
      const meta: SessionMeta = {
        ...session,
        state: 'running',
        endedAt: undefined,
        reason: undefined,
        turns: 1,
        agentPid: undefined,
      }
      await this.#writeMeta(meta)
      this.#nextSeq.set(session.id, 0)
      return meta
    })
  }

  /** The directory only. `settings.json` is written before the meta exists (D9). */
  async ensureDir(id: string): Promise<string> {
    const dir = this.#paths.sessionDir(id)
    await mkdir(dir, { recursive: true })
    return dir
  }

  async readMeta(id: string): Promise<SessionMeta | undefined> {
    return await this.#take(id, async () => await this.#readMeta(id))
  }

  /** Read-modify-write, atomically, with the turn held for the whole of it. */
  async patchMeta(
    id: string,
    patch: (current: SessionMeta) => SessionMeta,
  ): Promise<SessionMeta | undefined> {
    return await this.#take(id, async () => {
      const current = await this.#readMeta(id)
      if (current === undefined) return undefined
      const next = patch(current)
      await this.#writeMeta(next)
      return next
    })
  }

  /**
   * One event, persisted BEFORE this resolves.
   *
   * `seq` is assigned here and nowhere else, and `at` comes from the injected clock —
   * never `new Date()`, so a test can assert the order without waiting for it.
   */
  async append(id: string, event: EventInput): Promise<SessionEvent> {
    return await this.#take(id, async () => {
      const seq = await this.#seqFor(id)
      const full: SessionEvent = { ...event, seq, at: this.#now().toISOString() }

      // `a` and one write per event: an append under the size of a pipe buffer is not
      // interleaved with anyone else's, and the turn above means there is nobody else
      // anyway. The handle is closed even when the write throws.
      const handle = await open(this.#paths.eventsFile(id), 'a')
      try {
        await handle.writeFile(`${JSON.stringify(full)}\n`, 'utf8')
      } finally {
        await handle.close()
      }

      this.#nextSeq.set(id, seq + 1)
      return full
    })
  }

  /** The cursor. `fromSeq` is what the last page reported as `nextSeq`. */
  async read(
    id: string,
    fromSeq: number,
  ): Promise<{ readonly events: readonly SessionEvent[]; readonly nextSeq: number; readonly state: SessionState }> {
    return await this.#take(id, async () => {
      const all = await this.#readEvents(id)
      const meta = await this.#readMeta(id)
      const events = all.filter((event) => event.seq >= fromSeq)
      const last = all.at(-1)
      return {
        events,
        nextSeq: last === undefined ? fromSeq : last.seq + 1,
        state: stateFrom(all, meta?.state ?? 'failed'),
      }
    })
  }

  /**
   * Session ids, newest first.
   *
   * Sorted by id and that is deliberate: the ids are UUIDv7, so lexicographic order IS
   * chronological order, and listing the most recent N costs the same with five
   * thousand sessions as with fifty. It is also why there is no in-memory index — the
   * predecessor needed one only because it sorted by last event.
   */
  async listIds(): Promise<readonly string[]> {
    try {
      const entries = await readdir(this.#paths.sessions, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  sessionDir(id: string): string {
    return this.#paths.sessionDir(id)
  }

  settingsFile(id: string): string {
    return this.#paths.settingsFile(id)
  }

  async ensureRoots(): Promise<void> {
    await mkdir(this.#paths.locks, { recursive: true })
    await mkdir(this.#paths.sessions, { recursive: true })
  }
}
