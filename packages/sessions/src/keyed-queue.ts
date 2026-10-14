/**
 * A queue per key: the tasks of one key run one after the other, those of different keys do not
 * wait for each other. Taken out of `SiteLocks.#run` (spec 2026-10-07, D9) so the handoff has a
 * queue of its OWN per project: a handoff step that ran inside the locks' queue and called
 * `locks.release` of the same site would wait behind itself for ever.
 *
 * A REJECTED TASK DOES NOT LEAK into the next one: a disk error in one task must not leave the key
 * closed until a restart. The entry is deleted by IDENTITY, only when nothing has queued behind it,
 * so the map does not grow with the keys.
 */
export class KeyedQueue {
  readonly #queues = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    const tail = next.catch(() => undefined)
    this.#queues.set(key, tail)
    void tail.then(() => {
      if (this.#queues.get(key) === tail) this.#queues.delete(key)
    })
    return next
  }

  /** How many keys have a task queued or running. For the tests. */
  get size(): number {
    return this.#queues.size
  }
}
