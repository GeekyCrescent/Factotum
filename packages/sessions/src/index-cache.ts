/**
 * The history, in memory: every session's meta, for the lists, the projects screen and the search
 * (spec 2026-09-29, D6).
 *
 * BUILT ONCE, AT THE END OF `reconcile()`, AND KEPT IN STEP BY THE STORE. Block A measured reading
 * 500 metas at ~25 ms, so it is built in line, inside `start()`. From then on it hears every meta
 * the store writes and every session it deletes (`StoreObserver`), which includes what `reconcile`
 * itself writes: a session left `running` by a crash is `failed` here too (criterion 37).
 *
 * `ready` is what a request for a project waits on (criterion 14): the ids with history of removed
 * projects come from here, and before it is built nobody can say which ids are free.
 */

import { touchedOf, type SessionMeta, type SessionStore } from './store.ts'

/** Descending, for ISO instants and for ids alike — both compare lexicographically. */
const down = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0)

export class SessionIndex {
  readonly #metas = new Map<string, SessionMeta>()
  /** Ids deleted while the build runs: a meta read before its delete must not come back as a ghost. */
  readonly #dropped = new Set<string>()
  #ready = false

  get ready(): boolean {
    return this.#ready
  }

  /** Reads every meta once. Idempotent; the caller keeps it to one run. */
  async build(store: SessionStore): Promise<void> {
    for (const id of await store.listIds()) {
      const meta = await store.readMeta(id)
      if (meta !== undefined && !this.#metas.has(id) && !this.#dropped.has(id)) this.#metas.set(id, meta)
    }
    this.#dropped.clear()
    this.#ready = true
  }

  put(meta: SessionMeta): void {
    this.#metas.set(meta.id, meta)
  }

  drop(id: string): void {
    this.#metas.delete(id)
    if (!this.#ready) this.#dropped.add(id)
  }

  get(id: string): SessionMeta | undefined {
    return this.#metas.get(id)
  }

  /**
   * LAST INTERACTION FIRST, and this is THE order of the history: the lists,
   * each project's newest few, the search and the landing all read it from here, so a conversation
   * replied to this morning is at the top of every one of them.
   *
   * It used to be the id alone — UUIDv7, so creation order — and that is still the tie-break: two
   * conversations touched in the same millisecond, and a clock that went backwards, are left in a
   * stable order rather than whichever one the sort happened to see first.
   */
  all(): readonly SessionMeta[] {
    return [...this.#metas.values()].sort((a, b) => down(touchedOf(a), touchedOf(b)) || down(a.id, b.id))
  }

  bySite(siteId: string): readonly SessionMeta[] {
    return this.all().filter((meta) => meta.siteId === siteId)
  }
}
