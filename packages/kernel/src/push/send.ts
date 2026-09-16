/**
 * Sending one envelope to every subscription.
 *
 * THE FIRST CODE IN THIS DAEMON THAT LEAVES THE PRIVATE NETWORK (spec §0.4), so it lives in one
 * file and nowhere else.
 *
 * Every rule below is a measurement, not a preference:
 *
 * - ONLY 404 AND 410 UNSUBSCRIBE. FCM answered 410 to an unsubscribed device and to one whose
 *   permission was revoked (spec A6). It answered **403** to a mismatched VAPID pair — and the
 *   same subscription answered 201 again with the right pair. So 403 is OUR fault, and treating
 *   it as a dead device would turn a key problem into silently losing every phone.
 * - THE LIMIT IS 4096 ENCRYPTED BYTES, and encryption adds 103, so 3993 in clear (spec A5).
 *   Above it FCM answers 400. We check first and do not send.
 * - THE DEADLINE IS AN `AbortSignal`, handed to `fetch`. web-push's own `timeout` is an
 *   idle-socket timeout: against a server that trickles one byte a second it was still waiting
 *   after ten seconds (spec A7). A deadline has to be total, because in `stop()` this is the
 *   only thing between a stuck push service and a shutdown that never ends —
 *   `registry.stopAll()` has no `withTimeout`.
 * - NO RETRIES. A lost notice is lost. Retrying an `ask` whose window is already running buys
 *   nothing; retrying a "finished" buzzes twice, which is what gets notifications switched off.
 * - NEVER REJECTS, and never logs an endpoint: each one is a capability.
 */

import type { Logger, PushEnvelope } from '@factotum/core'
import webpush from 'web-push'
import type { VapidKeys } from './keys.ts'
import type { Subscription, SubscriptionStore } from './store.ts'

/**
 * How long ONE push service gets before we give up on it.
 *
 * Not derived from the hook: a send is fire-and-forget everywhere except `stop()`, where it
 * bounds the whole shutdown — once, not once per device, because the sends run concurrently.
 * So it must not be generous. The same order as `doctor.ts:238`, the repo's precedent.
 */
export const PUSH_TIMEOUT_MS = 5_000

/** 4096 encrypted bytes minus the 103 that aes128gcm adds. Measured, spec A5. */
export const MAX_PLAINTEXT_BYTES = 3993

/**
 * How long the push service holds a notice for a device that is offline. An hour: a "finished"
 * read an hour late still says something, and an `ask` answered after its window is refused
 * with a reason rather than acted on.
 */
const TTL_SECONDS = 3600

export interface Delivery {
  readonly statusCode: number
}

/**
 * THE SIGNAL IS IN THE CONTRACT, not a number of milliseconds. With a number, the only thing
 * that honours it is the real adapter — the one piece every test replaces with a double — so
 * the deadline would be tested nowhere. With the signal, a double can obey it and criterion 56
 * tests the real adapter against a server that never answers.
 */
export type Deliver = (
  subscription: Subscription,
  payload: string,
  options: { readonly signal: AbortSignal },
) => Promise<Delivery>

export interface SendDeps {
  readonly keys: VapidKeys
  readonly store: SubscriptionStore
  readonly log: Logger
  /** The VAPID `sub` claim: an https: URL or mailto: the push service can reach us at. */
  readonly subject: string
  readonly deliver?: Deliver
  readonly timeoutMs?: number
  /**
   * Who receives it. Defaults to every subscription at call time. EXPLICIT for the one caller
   * that must not include someone: announcing a new device goes to the devices that existed
   * BEFORE it (spec criterion 53), and relying on when this function happens to take its
   * snapshot would make that order an accident of the implementation.
   */
  readonly recipients?: readonly Subscription[]
}

export interface SendReport {
  readonly delivered: number
  readonly removed: number
  readonly failed: number
  /** Why nothing was attempted. Never contains the payload. */
  readonly skipped: string | undefined
}

/** Encrypts with web-push, sends with `fetch`. See the header for why not `sendNotification`. */
export function defaultDeliver(deps: { readonly keys: VapidKeys; readonly subject: string }): Deliver {
  const vapidDetails = { subject: deps.subject, publicKey: deps.keys.publicKey, privateKey: deps.keys.privateKey }

  return async (subscription, payload, { signal }) => {
    const request = webpush.generateRequestDetails(subscription, payload, {
      vapidDetails,
      TTL: TTL_SECONDS,
      // Every notice here is one a person is waiting for. `high` is what gets it through Doze.
      urgency: 'high',
    })
    const response = await fetch(request.endpoint, {
      method: request.method,
      headers: request.headers as Record<string, string>,
      body: request.body as Buffer,
      signal,
    })
    // Drain it, or the connection is held until the body is collected.
    await response.arrayBuffer().catch(() => undefined)
    return { statusCode: response.status }
  }
}

export async function sendToAll(envelope: PushEnvelope, deps: SendDeps): Promise<SendReport> {
  const payload = JSON.stringify(envelope)
  const bytes = Buffer.byteLength(payload, 'utf8')
  if (bytes > MAX_PLAINTEXT_BYTES) {
    const skipped = `notice not sent: ${bytes} bytes is over the push-service limit of ${MAX_PLAINTEXT_BYTES}`
    deps.log.warn(skipped)
    return { delivered: 0, removed: 0, failed: 0, skipped }
  }

  const deliver = deps.deliver ?? defaultDeliver(deps)
  const timeoutMs = deps.timeoutMs ?? PUSH_TIMEOUT_MS
  // A snapshot: a device that subscribes while this is running is not a recipient of it.
  const recipients = deps.recipients ?? deps.store.all()

  const outcomes = await Promise.allSettled(
    recipients.map(async (subscription) => {
      const { statusCode } = await deliver(subscription, payload, { signal: AbortSignal.timeout(timeoutMs) })
      return { subscription, statusCode }
    }),
  )

  let delivered = 0
  let removed = 0
  let failed = 0
  let vapidRejected = false
  const removals: Promise<void>[] = []

  for (const [index, outcome] of outcomes.entries()) {
    const host = hostOf(recipients[index])

    if (outcome.status === 'rejected') {
      failed++
      deps.log.warn(`push to ${host} did not complete: ${describe(outcome.reason)}`)
      continue
    }

    const { subscription, statusCode } = outcome.value
    if (statusCode >= 200 && statusCode < 300) {
      delivered++
    } else if (statusCode === 404 || statusCode === 410) {
      removals.push(
        deps.store.remove(subscription.endpoint).then(
          (didRemove) => {
            if (didRemove) removed++
          },
          (error: unknown) => deps.log.warn(`a dead subscription at ${host} could not be removed: ${describe(error)}`),
        ),
      )
    } else if (statusCode === 403) {
      failed++
      vapidRejected = true
    } else {
      failed++
      deps.log.warn(`push to ${host} was refused with ${statusCode}; the subscription is kept`)
    }
  }

  await Promise.all(removals)

  if (vapidRejected) {
    // ONE line, not one per device: this is a single cause.
    deps.log.error(
      'the push service rejected our VAPID credentials (403). The key pair no longer matches the ' +
        'one these subscriptions were created with — was keys.json replaced? Subscriptions were ' +
        'KEPT: they become valid again with the original pair.',
    )
  }

  return { delivered, removed, failed, skipped: undefined }
}

/** The host is not a capability; the path of an endpoint is. */
function hostOf(subscription: Subscription | undefined): string {
  try {
    return subscription === undefined ? 'unknown host' : new URL(subscription.endpoint).host
  } catch {
    return 'an unparseable endpoint'
  }
}

/** An error's name only: a network error's message can embed the full URL. */
function describe(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error'
}
