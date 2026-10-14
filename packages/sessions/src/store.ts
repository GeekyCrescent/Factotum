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

import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseLog, stateFrom } from './events.ts'
import { isSessionId } from './id.ts'
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
  /**
   * The agent this session was launched as (`--agent <name>`), or `undefined` for a plain one. Same
   * rule as `sitePath`: `string | undefined` AND REQUIRED, and listed in `#readMeta`. It is written
   * once, at launch; a reply never passes `--agent` and the session still is that agent.
   */
  readonly agent: string | undefined
  /**
   * The owner's title (spec 2026-09-29, D4). Listed in `#readMeta` like every field here, or the
   * next `patchMeta` — a finalize, a reconcile — would erase it (criterion 29).
   */
  readonly title: string | undefined
  /**
   * The title the titler wrote at launch (spec 2026-09-30, D1). A SIBLING of `title`, never the same
   * field: the owner's name wins over it, and clearing the owner's name shows it again. Listed in
   * `#readMeta` like every field here, or the next `patchMeta` would erase it (criterion 21).
   */
  readonly autoTitle: string | undefined
  /** When it was archived. `undefined`: not archived. */
  readonly archivedAt: string | undefined
  /**
   * WHEN THE OWNER LAST WROTE INTO IT: the launch, then every reply. What the history is ordered by
   * (`touchedOf`), because a conversation one talked to this morning is nearer than one opened last
   * month and never answered.
   *
   * The store owns it — `create` writes it and `reply` is the only other writer — so it is in the
   * `NewSession` omit list, not a field a caller may pass. Same rule as `sitePath`:
   * `string | undefined` AND REQUIRED, and listed in `#readMeta` or the next `patchMeta` erases it.
   * `undefined` is a meta from before the field, and `touchedOf` says what it means.
   */
  readonly touchedAt: string | undefined
  /**
   * Where this conversation went, and when (spec 2026-10-07-dos-hosts, D8): set on the SOURCE once
   * the other host confirmed it, and from then on the session is read-only here — a reply is
   * `moved`. Same rule as `sitePath`: `string | undefined` AND REQUIRED, listed in `parseMeta`, and
   * in the `NewSession` omit list. A meta from before the field reads as not moved.
   */
  readonly movedTo: string | undefined
  readonly movedAt: string | undefined
}

/**
 * The order of the history, as ONE function: when the owner last wrote into
 * this conversation, and for a meta from before `touchedAt` the best the file still offers — the end
 * of its last turn, else its start. Never `undefined`, so a comparator needs no second rule.
 *
 * The fallback is what makes the change retroactive: every conversation already on disk sorts by
 * roughly when it was last worked on, without a migration that rewrites five hundred metas.
 */
export function touchedOf(meta: SessionMeta): string {
  return meta.touchedAt ?? meta.endedAt ?? meta.startedAt
}

/**
 * Who hears about every meta the store writes and every session it deletes: the history index
 * (`index-cache.ts`), which is how it sees what `reconcile` writes too (criterion 37).
 */
export interface StoreObserver {
  readonly written: (meta: SessionMeta) => void
  readonly removed: (id: string) => void
}

/** What deleting one came to (criterion 33). */
export type RemoveOutcome = 'removed' | 'unknown' | 'running'

/** Everything but the parts the store owns. */
export type NewSession = Omit<
  SessionMeta,
  'state' | 'endedAt' | 'reason' | 'turns' | 'agentPid' | 'title' | 'autoTitle' | 'archivedAt' | 'touchedAt' | 'movedTo' | 'movedAt'
>

/** Where `importSession` is about to move something: the journal writes its intention first (D9). */
export type ImportStep = 'replace' | 'install'

/**
 * A `meta.json` as a `SessionMeta`, or `undefined` when it is not one. PURE, and THE ONE LIST OF
 * FIELDS: `#readMeta` reads through it, and so does the handoff when a meta arrives from the other
 * host (spec 2026-10-07-dos-hosts, D8, v4.2) — a field missing here would be lost on the way.
 *
 * EVERY FIELD IS LISTED BY HAND, and a field left out of this list is not just unread: it is ERASED,
 * because `patchMeta` reads through here and writes the result back. It is the
 * zod-strips-unknown-keys trap of CLAUDE.md §2 in handwritten form — and `sitePath` would have
 * fallen into it if the type had allowed it to be optional (TS2741 caught it).
 */
export function parseMeta(id: string, value: unknown): SessionMeta | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const json = value as Partial<SessionMeta>
  // THE DIRECTORY NAMES THE SESSION, not the file's contents: a meta.json whose `id` says
  // something else is not this session's, and an id read from a file must never become a path.
  if (json.id !== id || typeof json.siteId !== 'string') return undefined
  const text = (field: unknown) => (typeof field === 'string' ? field : undefined)
  return {
    id: json.id,
    siteId: json.siteId,
    entryId: typeof json.entryId === 'string' ? json.entryId : '',
    // A state this code does not know reads as `failed`: a meta from the other host is outside input.
    state: json.state === 'running' || json.state === 'finished' || json.state === 'cancelled' ? json.state : 'failed',
    startedAt: typeof json.startedAt === 'string' ? json.startedAt : new Date(0).toISOString(),
    endedAt: json.endedAt ?? undefined,
    reason: json.reason ?? undefined,
    turns: typeof json.turns === 'number' ? json.turns : 1,
    agentPid: typeof json.agentPid === 'number' ? json.agentPid : undefined,
    sitePath: text(json.sitePath),
    prompt: text(json.prompt),
    agent: text(json.agent),
    title: text(json.title),
    autoTitle: text(json.autoTitle),
    archivedAt: text(json.archivedAt),
    touchedAt: text(json.touchedAt),
    movedTo: text(json.movedTo),
    movedAt: text(json.movedAt),
  }
}

export class SessionStore {
  readonly #paths: SessionPaths
  readonly #now: () => Date
  /** One chain per session id. Serialises writes; see the header. */
  readonly #turns = new Map<string, Promise<unknown>>()
  readonly #nextSeq = new Map<string, number>()
  /**
   * TOMBSTONES: ids deleted in this process. A reply already past its checks when the delete ran
   * must not bring the directory back (`ensureDir`, `append`), or a deleted conversation would
   * reappear as a folder with a settings file and nothing else (criterion 33).
   */
  readonly #removed = new Set<string>()
  #observer: StoreObserver | undefined

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

  /** One observer; the engine's index. */
  observe(observer: StoreObserver): void {
    this.#observer = observer
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
    this.#observer?.written(meta)
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
      return parseMeta(id, JSON.parse(await readFile(this.#paths.metaFile(id), 'utf8')))
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
        title: undefined,
        autoTitle: undefined,
        archivedAt: undefined,
        // The launch IS the first interaction, and the id's own time is already this instant.
        touchedAt: session.startedAt,
        movedTo: undefined,
        movedAt: undefined,
      }
      await this.#writeMeta(meta)
      this.#nextSeq.set(session.id, 0)
      return meta
    })
  }

  /**
   * The directory only. `settings.json` is written before the meta exists (D9). `undefined` for a
   * session deleted in this process: its directory is not made again (criterion 33).
   */
  async ensureDir(id: string): Promise<string | undefined> {
    // IN THE TURN, so a delete cannot land between the tombstone check and the `mkdir`.
    return await this.#take(id, async () => {
      if (this.#removed.has(id)) return undefined
      const dir = this.#paths.sessionDir(id)
      await mkdir(dir, { recursive: true })
      return dir
    })
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
      // `open(…, 'a')` would create the file again inside a directory made again by someone.
      if (this.#removed.has(id)) throw new Error('that conversation was deleted')
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
   * thousand sessions as with fifty.
   *
   * THIS IS NO LONGER THE ORDER OF THE HISTORY. It is the order the index is BUILT in, and nothing
   * reads it for a list: a list is ordered by `touchedOf`, which only the index — already in memory
   * for the lists, the projects screen and the search — can sort by without reading the disk again.
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

  /**
   * Deletes one conversation, IN ITS TURN, so nothing interleaves with it (criterion 33).
   *
   * `isLive` is the engine's: the store does not see the live map. A live session, or a meta that
   * says `running`, is not deleted. A directory with no meta — a launch that died before writing
   * one — is deleted like any other. The tombstone goes up BEFORE the files go, and nothing is
   * followed out of `sessions/`: a symlink in its place is unlinked, not walked, and `rm` does not
   * follow the links inside.
   */
  async remove(id: string, isLive: (id: string) => boolean): Promise<RemoveOutcome> {
    // Checked HERE too, whoever calls: this id becomes a path under `sessions/` and is deleted.
    if (!isSessionId(id)) return 'unknown'
    return await this.#take(id, async () => {
      if (isLive(id)) return 'running'
      const meta = await this.#readMeta(id)
      if (meta?.state === 'running') return 'running'
      const dir = this.#paths.sessionDir(id)
      let isLink: boolean
      try {
        isLink = (await lstat(dir)).isSymbolicLink()
      } catch {
        return 'unknown'
      }
      if (isLink) {
        // The link's own entry, which lives in `sessions/`; what it points at is not touched.
        await unlink(dir)
      } else {
        // Belt and braces for the one thing that must never happen: deleting outside `sessions/`.
        if (dirname(await realpath(dir)) !== (await realpath(this.#paths.sessions))) return 'unknown'
        await rm(dir, { recursive: true, force: true })
      }
      // Only once it is gone: a delete that failed leaves a session that still works.
      this.#removed.add(id)
      this.#nextSeq.delete(id)
      this.#observer?.removed(id)
      return 'removed'
    })
  }

  /**
   * A session that arrived from the other host goes in (spec 2026-10-07-dos-hosts, D8), IN ITS TURN.
   *
   * An existing `sessions/<id>/` — the way back — is moved to `<replacedDir>/<id>` first, never
   * deleted: until the handoff ends it may be the owner's only copy. `before(step)` is awaited before
   * each move, so the handoff writes its journal's intention first; if it throws, that move does not
   * happen. The meta written is THE ONE GIVEN — this host's `siteId` and `sitePath`, not the
   * source's — and the index hears it through the observer.
   */
  async importSession(id: string, dir: string, replacedDir: string, before: (step: ImportStep) => Promise<void>, meta: SessionMeta): Promise<void> {
    if (!isSessionId(id)) throw new Error(`"${id}" is not a session id`)
    await this.#take(id, async () => {
      const target = this.#paths.sessionDir(id)
      if ((await lstat(target).catch(() => undefined)) !== undefined) {
        await before('replace')
        await mkdir(replacedDir, { recursive: true })
        await rename(target, join(replacedDir, id))
      }
      await before('install')
      await rename(dir, target)
      this.#nextSeq.delete(id)
      this.#removed.delete(id)
      await this.#writeMeta(meta)
    })
  }

  /**
   * The undo of an import (D9): the session goes WITHOUT a tombstone — this is not the owner
   * deleting it, and a `restoreSession` may bring the old one back. The index hears `removed`.
   */
  async discardImported(id: string): Promise<void> {
    if (!isSessionId(id)) throw new Error(`"${id}" is not a session id`)
    await this.#take(id, async () => {
      await rm(this.#paths.sessionDir(id), { recursive: true, force: true })
      this.#nextSeq.delete(id)
      this.#observer?.removed(id)
    })
  }

  /** The session an import replaced, back in its place (D9). The index hears its meta again. */
  async restoreSession(id: string, from: string): Promise<void> {
    if (!isSessionId(id)) throw new Error(`"${id}" is not a session id`)
    await this.#take(id, async () => {
      await rename(from, this.#paths.sessionDir(id))
      this.#nextSeq.delete(id)
      this.#removed.delete(id)
      const meta = await this.#readMeta(id)
      if (meta !== undefined) await this.#writeMeta(meta)
    })
  }

  sessionDir(id: string): string {
    return this.#paths.sessionDir(id)
  }

  settingsFile(id: string): string {
    return this.#paths.settingsFile(id)
  }

  mcpConfigFile(id: string): string {
    return this.#paths.mcpConfigFile(id)
  }

  async ensureRoots(): Promise<void> {
    await mkdir(this.#paths.locks, { recursive: true })
    await mkdir(this.#paths.sessions, { recursive: true })
  }
}
