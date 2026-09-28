/**
 * The subscriptions, one per device, in `<root>/push/subscriptions.json`.
 *
 * EVERY ENDPOINT IS A CAPABILITY: whoever holds it can push to that device. So the file is
 * owner-only, nothing here logs an endpoint, and no HTTP route ever returns this list — only a
 * count (spec criterion 10).
 *
 * DERIVED STATE, so it degrades rather than defends. An unreadable file becomes zero
 * subscriptions with a warning: the cost is that each device subscribes again, not that the
 * daemon refuses to start.
 *
 * MUTATIONS ARE SERIALISED, and that is the point of `#queue`. A send that finds two dead
 * subscriptions removes both concurrently; without a queue each removal would write its own
 * view of the list and the second write would resurrect the first removal.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

export const SUBSCRIPTIONS_FILE = 'subscriptions.json'

export interface Subscription {
  /** Compared as the exact string the push service gave. Never normalised. */
  readonly endpoint: string
  readonly keys: { readonly p256dh: string; readonly auth: string }
  /**
   * Whether it came from a browser on the daemon's own machine (spec 2026-09-18, design D12).
   * Computed by the kernel from the request, never read from the body. Absent on a subscription
   * from before the field existed.
   */
  readonly sameMachine?: boolean
}

export interface OpenResult {
  readonly store: SubscriptionStore
  /** Why something on disk was ignored. Never contains an endpoint. */
  readonly warning: string | undefined
}

const FILE_MODE = 0o600

export class SubscriptionStore {
  readonly #file: string
  #list: readonly Subscription[]
  #queue: Promise<void> = Promise.resolve()

  private constructor(file: string, list: readonly Subscription[]) {
    this.#file = file
    this.#list = list
  }

  /** NEVER THROWS. See the header: this is derived state. */
  static async open(dir: string): Promise<OpenResult> {
    const file = join(dir, SUBSCRIPTIONS_FILE)

    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { store: new SubscriptionStore(file, []), warning: undefined }
      return { store: new SubscriptionStore(file, []), warning: `${file} could not be read; starting with no subscriptions` }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { store: new SubscriptionStore(file, []), warning: `${file} is not valid JSON; starting with no subscriptions` }
    }

    if (!Array.isArray(parsed)) {
      return { store: new SubscriptionStore(file, []), warning: `${file} does not hold a list; starting with no subscriptions` }
    }

    const valid = parsed.filter(isSubscription)
    const dropped = parsed.length - valid.length
    const warning = dropped === 0 ? undefined : `${file} held ${dropped} entries that are not subscriptions; they were ignored`
    return { store: new SubscriptionStore(file, valid), warning }
  }

  all(): readonly Subscription[] {
    return [...this.#list]
  }

  count(): number {
    return this.#list.length
  }

  has(endpoint: string): boolean {
    return this.#list.some((s) => s.endpoint === endpoint)
  }

  /** Replaces the entry with the same endpoint, or appends. */
  async upsert(subscription: Subscription): Promise<void> {
    await this.#mutate((list) => {
      const others = list.filter((s) => s.endpoint !== subscription.endpoint)
      const existed = others.length !== list.length
      return existed
        ? list.map((s) => (s.endpoint === subscription.endpoint ? subscription : s))
        : [...list, subscription]
    })
  }

  /** `true` if something was removed. */
  async remove(endpoint: string): Promise<boolean> {
    let removed = false
    await this.#mutate((list) => {
      const next = list.filter((s) => s.endpoint !== endpoint)
      removed = next.length !== list.length
      return next
    })
    return removed
  }

  async clear(): Promise<void> {
    await this.#mutate(() => [])
  }

  /**
   * Computes the next list from the CURRENT one inside the queue, so a mutation always sees
   * the result of the one before it. The in-memory list only changes once the file has.
   */
  async #mutate(next: (list: readonly Subscription[]) => readonly Subscription[]): Promise<void> {
    const run = this.#queue.then(async () => {
      const list = next(this.#list)
      await this.#persist(list)
      this.#list = list
    })
    // A failed write must not poison every write after it.
    this.#queue = run.catch(() => undefined)
    await run
  }

  async #persist(list: readonly Subscription[]): Promise<void> {
    // TEMP + RENAME, like `SessionStore#writeMeta`: a reader sees the old file or the new one,
    // never half. A unique temporary name, so a crash leaves debris instead of a collision.
    const temporary = `${this.#file}.${randomBytes(6).toString('hex')}.tmp`
    await mkdir(join(this.#file, '..'), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(list, null, 2)}\n`, { mode: FILE_MODE })
    await rename(temporary, this.#file)
  }
}

function isSubscription(value: unknown): value is Subscription {
  if (value === null || typeof value !== 'object') return false
  const { endpoint, keys, sameMachine } = value as Record<string, unknown>
  if (typeof endpoint !== 'string' || keys === null || typeof keys !== 'object') return false
  if (sameMachine !== undefined && typeof sameMachine !== 'boolean') return false
  const { p256dh, auth } = keys as Record<string, unknown>
  return typeof p256dh === 'string' && typeof auth === 'string'
}
