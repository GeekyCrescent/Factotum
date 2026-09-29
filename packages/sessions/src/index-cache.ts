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

import type { SessionMeta, SessionStore } from './store.ts'

export class SessionIndex {
  readonly #metas = new Map<string, SessionMeta>()
  #ready = false

  get ready(): boolean {
    return this.#ready
  }

  /** Reads every meta once. Idempotent; the caller keeps it to one run. */
  async build(store: SessionStore): Promise<void> {
    for (const id of await store.listIds()) {
      const meta = await store.readMeta(id)
      if (meta !== undefined && !this.#metas.has(id)) this.#metas.set(id, meta)
    }
    this.#ready = true
  }

  put(meta: SessionMeta): void {
    this.#metas.set(meta.id, meta)
  }

  drop(id: string): void {
    this.#metas.delete(id)
  }

  get(id: string): SessionMeta | undefined {
    return this.#metas.get(id)
  }

  /** Newest first: the ids are UUIDv7, so sorting by id is sorting by time. */
  all(): readonly SessionMeta[] {
    return [...this.#metas.values()].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  }

  bySite(siteId: string): readonly SessionMeta[] {
    return this.all().filter((meta) => meta.siteId === siteId)
  }
}
