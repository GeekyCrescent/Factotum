/**
 * The daemon's push capability, assembled: keys, subscriptions, sending, and the detection that
 * stands in for the credential this project does not have.
 *
 * WHAT A MODULE GETS IS A SLICE OF THIS — `canReach` and `send`, with its id bound by the
 * registry. Everything else here (the public key, subscribing, the count, reset) is for the
 * kernel's own routes and for the CLI.
 *
 * THE THREAT MODEL, IN ONE PARAGRAPH, because it shapes `subscribe`. The subscription route has
 * no credential, and the origin check only fires when a request carries `Origin` — so anything
 * on this machine, including a gated agent with `Bash`, can register a device. That cannot be
 * closed here, and pretending otherwise would be worse than saying it (spec §5). What IS done:
 * a new device is announced to the ones that already exist, and the count is capped and
 * visible. Detection, not prevention.
 */

import type { Logger, NotificationMessage, PushEnvelope } from '@factotum/core'
import { inspectKeys, loadOrCreateKeys, type VapidKeys } from './keys.ts'
import { SubscriptionStore, type Subscription } from './store.ts'
import { sendToAll, type Deliver } from './send.ts'

/**
 * Small on purpose. A person has a handful of devices; a cap in the dozens would let a flood of
 * registrations drown the one announcement that matters. Leaving it is `factotum push reset`.
 */
export const MAX_SUBSCRIPTIONS = 5

export interface PushServiceDeps {
  /** `statePaths(...).push`. */
  readonly dir: string
  /** The hostname of `publicOrigin`, so two machines' notices can be told apart. */
  readonly machine: string
  /** The VAPID `sub` claim. `publicOrigin` is an https: URL this daemon owns. */
  readonly subject: string
  readonly log: Logger
  readonly deliver?: Deliver
  readonly timeoutMs?: number
  readonly generate?: () => VapidKeys
}

export type SubscribeResult =
  | { readonly kind: 'subscribed'; readonly count: number }
  | { readonly kind: 'full'; readonly count: number; readonly reason: string }
  | { readonly kind: 'off'; readonly reason: string }

export type PushStatus =
  | { readonly kind: 'ready'; readonly subscriptions: number }
  | { readonly kind: 'off'; readonly reason: string }

export interface PushService {
  /** SYNCHRONOUS. The permission gate asks it before deciding whether it may ask at all. */
  readonly canReach: () => boolean
  /** Never rejects. `moduleId` is bound by the registry; `null` is the daemon itself. */
  readonly send: (message: NotificationMessage, moduleId: string | null) => Promise<void>
  readonly publicKey: () => string | undefined
  readonly subscribe: (subscription: Subscription) => Promise<SubscribeResult>
  readonly count: () => number
  readonly reset: () => Promise<void>
  readonly status: () => PushStatus
  /** Resolves when every notice fired without `await` has finished. For shutdown, and tests. */
  readonly settled: () => Promise<void>
}

export async function createPushService(deps: PushServiceDeps): Promise<PushService> {
  const keysResult = await loadOrCreateKeys({ dir: deps.dir, ...(deps.generate !== undefined ? { generate: deps.generate } : {}) })

  if (keysResult.kind === 'unavailable') {
    deps.log.warn(keysResult.reason)
    return offService(keysResult.reason)
  }

  const { store, warning } = await SubscriptionStore.open(deps.dir)
  if (warning !== undefined) deps.log.warn(warning)

  const keys = keysResult.keys
  const inFlight = new Set<Promise<void>>()

  /** Returns the settled promise, so a caller that DOES want to wait can await the same thing. */
  const track = (work: Promise<unknown>): Promise<void> => {
    // The `.catch` IS NOT OPTIONAL: an unhandled rejection kills the process in Node 22+
    // (spec criterion 47), and `sendToAll` touches the disk when it removes a dead device.
    const settled = work.then(
      () => undefined,
      (error: unknown) => deps.log.warn(`a background notice failed: ${error instanceof Error ? error.name : 'error'}`),
    )
    inFlight.add(settled)
    void settled.finally(() => inFlight.delete(settled))
    return settled
  }

  const envelope = (message: NotificationMessage, moduleId: string | null): PushEnvelope => ({
    message,
    moduleId,
    machine: deps.machine,
  })

  const sendDeps = {
    keys,
    store,
    log: deps.log,
    subject: deps.subject,
    ...(deps.deliver !== undefined ? { deliver: deps.deliver } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  }

  return {
    canReach: () => store.count() > 0,

    send: async (message, moduleId) => {
      if (store.count() === 0) return
      // TRACKED, so `settled()` covers it. The engine fires its end-of-turn notices without
      // awaiting — in `stop()` above all — and boot drains them through `settled()` before it
      // closes. An untracked send there would be cut off by the shutdown it is announcing.
      await track(sendToAll(envelope(message, moduleId), sendDeps))
    },

    publicKey: () => keys.publicKey,

    subscribe: async (subscription) => {
      const isNew = !store.has(subscription.endpoint)
      const before = store.all()

      if (isNew && before.length >= MAX_SUBSCRIPTIONS) {
        return {
          kind: 'full',
          count: before.length,
          reason:
            `this machine already has ${before.length} subscribed devices, the most it accepts. ` +
            'If some are not yours, or are gone, run `factotum push reset` on this machine and ' +
            'subscribe again from each device you use.',
        }
      }

      // THE ORDER IS THE DETECTION (spec D3). Announce to the devices that existed BEFORE, and
      // only then store the new one — so the newcomer is never told it was noticed. The
      // recipients are passed explicitly rather than trusting when a snapshot happens to be taken.
      if (isNew && before.length > 0) {
        const total = before.length + 1
        track(
          sendToAll(
            envelope(
              {
                title: 'new device',
                body: `${total} devices are now subscribed to this machine. Not you? Run: factotum push reset`,
                path: '/',
                tag: 'subscription',
              },
              null,
            ),
            { ...sendDeps, recipients: before },
          ),
        )
      }

      await store.upsert(subscription)
      return { kind: 'subscribed', count: store.count() }
    },

    count: () => store.count(),

    reset: async () => {
      await store.clear()
    },

    status: () => ({ kind: 'ready', subscriptions: store.count() }),

    settled: async () => {
      await Promise.all([...inFlight])
    },
  }
}

function offService(reason: string): PushService {
  return {
    canReach: () => false,
    send: async () => undefined,
    publicKey: () => undefined,
    subscribe: async () => ({ kind: 'off', reason }),
    count: () => 0,
    reset: async () => undefined,
    status: () => ({ kind: 'off', reason }),
    settled: async () => undefined,
  }
}

export type PushInspection =
  /** Nothing yet. The daemon creates a pair on its next start. */
  | { readonly kind: 'no-keys' }
  | { readonly kind: 'unusable'; readonly reason: string }
  | { readonly kind: 'ready'; readonly subscriptions: number; readonly warning: string | undefined }

/**
 * What `doctor` reports, READ-ONLY. Never creates a key, never rewrites a file. It prints no key
 * and no endpoint: a count is all it returns (spec criterion 3).
 */
export async function inspectPush(dir: string): Promise<PushInspection> {
  const keys = await inspectKeys(dir)
  if (keys.kind === 'missing') return { kind: 'no-keys' }
  if (keys.kind === 'unavailable') return { kind: 'unusable', reason: keys.reason }
  const { store, warning } = await SubscriptionStore.open(dir)
  return { kind: 'ready', subscriptions: store.count(), warning }
}

/**
 * `factotum push reset`: forget every device. Returns how many there were.
 *
 * DO NOT CALL THIS WHILE THE DAEMON FOR THIS ENVIRONMENT RUNS. The daemon holds the list in
 * memory and writes it whole on its next change, which would bring back everything cleared
 * here. The CLI checks before calling; this function cannot, because it does not know the port.
 */
export async function resetSubscriptions(dir: string): Promise<number> {
  const { store } = await SubscriptionStore.open(dir)
  const had = store.count()
  await store.clear()
  return had
}
