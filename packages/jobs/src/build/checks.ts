/**
 * The address-check queue (task N4, design D9 «Cuándo se comprueba»; requirements crit. 24, 46, 46b).
 *
 * ITS OWN QUEUE, ONE CHECK AT A TIME, outside Claude's. Each check runs `checkAddress` (N2) under
 * `CHECK_DEADLINE_MS` on the injected timers; when it runs out the search is aborted and the address
 * is left `unverified` with `checkedAt` (T-D4, `timedOut`). A check goes `pending → running → done |
 * timed-out` (`stateOf`).
 *
 * WHERE THE STATE LIVES. The order of the queue is in memory. What survives a restart is the
 * contact's own `address_status = 'checking'` (D3: «comprobación encolada o en curso»): enqueueing
 * writes T-D2, the startup write turns every `checking` back into `unverified` with `checkedAt = null`
 * (T-D6) and `enqueueRestarted` puts those first again. Nothing else is stored, and schema v1 is
 * untouched. (The AD check of N3 is the application's, in `applications.checks`.)
 *
 * WHO CALLS WHAT (design D9's list):
 * - the seed import, right after importing → `enqueueContacts(contactIds, { front: true })` (its
 *   hook; `enqueueSeedChecks(files)` is the same by seed file), in front of the rest;
 * - an email application reaching `ready`/`in-review` → `enqueueApplicationCheck(id)`;
 * - every tick (D16) → `prepareTick({ batchSize })` for the next `2 × batchSize` candidates;
 * - startup, after the opening `tx` → `enqueueRestarted()`, in front;
 * - approving with a pending or stale check (E2, `conflict check-pending`) and `startBatch` →
 *   `enqueueCheck(contactId, { front: true })`.
 */

import type { Logger, Timers } from '@factotum/core'

import { isStaleCheck, addressTransition } from '../state.ts'
import type { Db, Queries } from '../store/db.ts'
import { batchCandidateContacts, getApplication, getContact, restartedContacts, saveContact, seedCheckContacts } from '../store/repo.ts'
import { fail, ok, type Address, type Result } from '../types.ts'
import { applyAddressOutcome, checkAddress, type AddressSearch } from './address.ts'

/** design D9: a check (home page + 6 pages, with net's courtesy per host) gets one minute. */
export const CHECK_DEADLINE_MS = 60_000

export type CheckState = 'pending' | 'running' | 'done' | 'timed-out'

/**
 * - `queued`: written `checking` (T-D2) and added;
 * - `moved`: already pending, now in front;
 * - `already`: pending or running, left where it is;
 * - `fresh`: a finished check that is not stale — nothing to do;
 * - `no-check`: an application that is not sent by email.
 */
export type Enqueued = 'queued' | 'moved' | 'already' | 'fresh' | 'no-check'

export interface EnqueueOptions {
  readonly front?: boolean
}

export interface CheckQueueDeps {
  readonly db: Db
  readonly timers: Timers
  readonly now: () => Date
  /** `addressSearch(net)` in production. */
  readonly search: AddressSearch
  readonly log: Logger
}

export interface PrepareTickOptions {
  readonly batchSize: number
  /** The contacts of the next batch's items in order (null: an item with no address). Default: `batchCandidateContacts`. */
  readonly candidates?: readonly (string | null)[]
}

export interface CheckQueue {
  readonly enqueueCheck: (contactId: string, options?: EnqueueOptions) => Result<Enqueued>
  readonly enqueueApplicationCheck: (applicationId: string, options?: EnqueueOptions) => Result<Enqueued>
  /**
   * These contacts, each one whose check is due (`isDue`: `checking`, or `checkedAt` missing or stale —
   * `verified` included), at the back or in front. The seed import's hook. Returns how many were
   * queued: one already pending (`moved`/`already`), fresh or refused (logged) does not count.
   */
  readonly enqueueContacts: (contactIds: readonly string[], options?: EnqueueOptions) => number
  /** The due addresses (as `enqueueContacts`) of the unsent email applications of these seed files, in front. Returns how many were queued. */
  readonly enqueueSeedChecks: (files: readonly string[]) => number
  /** The contacts the startup write took out of `checking` (T-D6), in front. Returns how many. */
  readonly enqueueRestarted: () => number
  /** The next `2 × batchSize` candidates with a pending or stale check, at the back. Returns how many were queued. */
  readonly prepareTick: (options: PrepareTickOptions) => number
  readonly stateOf: (contactId: string) => CheckState | null
  readonly pending: () => readonly string[]
  readonly running: () => string | null
  readonly idle: () => boolean
  /** Cancels the running check WITHOUT writing (its contact stays `checking`; startup recovers it) and drops the rest. */
  readonly stop: () => Promise<void>
}

/** A check is due when one is under way or the last one is missing or stale (v5, X2). */
const isDue = (address: Address, now: Date): boolean => address.status === 'checking' || isStaleCheck(address, now)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createCheckQueue(deps: CheckQueueDeps): CheckQueue {
  const { db, timers, now, log } = deps
  let queue: readonly string[] = []
  let current: { readonly contactId: string; readonly controller: AbortController } | null = null
  let active: Promise<void> | null = null
  let stopped = false
  const states = new Map<string, CheckState>()

  /** T-D2 in its own `tx`; decides only — the queue's order is the caller's. */
  function admit(q: Queries, contactId: string, at: Date): Result<Enqueued> {
    if (current?.contactId === contactId) return ok('already')
    const contact = getContact(q, contactId)
    if (contact === undefined) return fail('not-found', 'no such contact')
    if (contact.address === null) return fail('conflict', 'the contact has no address')
    if (queue.includes(contactId)) return ok('already')
    if (!isDue(contact.address, at)) return ok('fresh')
    if (contact.address.status === 'checking') return ok('queued') // checking but not in this queue: adopt it
    const moved = addressTransition(contact, { type: 'enqueue-check' }, at)
    if (!moved.ok) return moved
    saveContact(q, moved.value, { kind: 'address-checked', data: { state: 'pending' } }, at)
    return ok('queued')
  }

  /** Admits each contact; the ones queued or moved go in front (in their order) or at the back. */
  function enqueueMany(contactIds: readonly string[], front: boolean): readonly Result<Enqueued>[] {
    if (stopped) return contactIds.map(() => fail('conflict', 'the check queue is stopped'))
    const at = now()
    const results: Result<Enqueued>[] = []
    const block: string[] = []
    for (const contactId of contactIds) {
      if (block.includes(contactId)) {
        results.push(ok('already'))
        continue
      }
      const pendingBefore = queue.includes(contactId)
      let result = db.tx((q) => admit(q, contactId, at))
      if (result.ok && result.value === 'already' && pendingBefore && front) result = ok('moved')
      if (result.ok && (result.value === 'queued' || result.value === 'moved')) block.push(contactId)
      results.push(result)
    }
    const rest = queue.filter((id) => !block.includes(id))
    queue = front ? [...block, ...rest] : [...rest, ...block]
    for (const id of block) states.set(id, 'pending')
    kick()
    return results
  }

  /** The bulk callers: each refusal is logged (nobody is there to read a `Result`), the queued ones counted. */
  function enqueueCounted(contactIds: readonly string[], front: boolean): number {
    const results = enqueueMany(contactIds, front)
    results.forEach((result, i) => {
      if (!result.ok) log.warn(`address check of ${contactIds[i]} not queued: ${result.error.code} ${result.error.reason}`)
    })
    return results.filter((r) => r.ok && r.value === 'queued').length
  }

  async function runOne(contactId: string): Promise<void> {
    const controller = new AbortController()
    current = { contactId, controller }
    states.set(contactId, 'running')
    let timedOut = false
    const deadline = timers.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, CHECK_DEADLINE_MS)
    const aborted = new Promise<'aborted'>((resolve) => controller.signal.addEventListener('abort', () => resolve('aborted'), { once: true }))
    const work = checkAddress({ db, search: deps.search, now }, contactId, controller.signal).catch((error: unknown) =>
      fail('module-error', messageOf(error)),
    )
    const result = await Promise.race([work, aborted]) // never rejects: `work` is caught above
    deadline[Symbol.dispose]()
    current = null
    if (result !== 'aborted') return settle(contactId, result, 'done', 'not written')
    if (!timedOut) return // stop(): no write, the contact stays `checking`
    const written = db.tx((q) => applyAddressOutcome(q, contactId, { kind: 'timed-out' }, now()))
    settle(contactId, written, 'timed-out', 'timed out and was not written')
  }

  /**
   * Records how a check ended. A write that failed with the contact still `checking` (a disk error,
   * a busy store) is NOT retried here: the state is dropped so memory agrees with the store, and the
   * contact is adopted again by its next `enqueueCheck`/`prepareTick` (`admit`) or, at the latest,
   * by the startup write (T-D6) and `enqueueRestarted`. A retry would repeat a minute of network
   * against the same failing store.
   */
  function settle(contactId: string, written: Result<unknown>, state: CheckState, what: string): void {
    if (written.ok) {
      states.set(contactId, state)
      return
    }
    const stillChecking = db.read((q) => getContact(q, contactId)?.address?.status === 'checking')
    if (stillChecking) states.delete(contactId)
    else states.set(contactId, state)
    const after = stillChecking ? '; still checking, its next enqueue or the restart checks it again' : ''
    log.warn(`address check of ${contactId} ${what}: ${written.error.code} ${written.error.reason}${after}`)
  }

  async function drain(): Promise<void> {
    while (!stopped && queue.length > 0) {
      const [next, ...rest] = queue
      queue = rest
      if (next !== undefined) await runOne(next)
    }
  }

  function kick(): void {
    if (active !== null || stopped || queue.length === 0) return
    active = drain()
      .catch((error: unknown) => log.error(`the address-check queue failed: ${messageOf(error)}`))
      .finally(() => {
        active = null
        kick()
      })
  }

  const firstOf = (results: readonly Result<Enqueued>[]): Result<Enqueued> => results[0] ?? fail('invalid', 'nothing to enqueue')

  return {
    enqueueCheck: (contactId, options = {}) => firstOf(enqueueMany([contactId], options.front === true)),

    enqueueApplicationCheck: (applicationId, options = {}) => {
      const app = db.read((q) => getApplication(q, applicationId))
      if (app === undefined) return fail('not-found', 'no such application')
      if (app.channel !== 'email' || app.target.contactId === null) return ok('no-check')
      return firstOf(enqueueMany([app.target.contactId], options.front === true))
    },

    enqueueContacts: (contactIds, options = {}) => enqueueCounted(contactIds, options.front === true),

    // No status filter: `admit`'s `isDue` decides, so a package-«seen» `verified` never checked is due too.
    enqueueSeedChecks: (files) => enqueueCounted(db.read((q) => seedCheckContacts(q, files)), true),

    enqueueRestarted: () => enqueueCounted(db.read(restartedContacts), true),

    prepareTick: ({ batchSize, candidates }) => {
      const all = candidates ?? db.read((q) => batchCandidateContacts(q, now()))
      const window = all.slice(0, 2 * batchSize).filter((id): id is string => id !== null)
      return enqueueCounted([...new Set(window)], false)
    },

    stateOf: (contactId) => states.get(contactId) ?? null,
    pending: () => queue,
    running: () => current?.contactId ?? null,
    idle: () => current === null && queue.length === 0,

    stop: async () => {
      stopped = true
      queue = []
      current?.controller.abort()
      await active
    },
  }
}
