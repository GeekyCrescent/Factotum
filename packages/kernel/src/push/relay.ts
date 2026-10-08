/**
 * The push relay (spec 2026-10-07, D6): ONE app on the phone, two daemons behind it.
 *
 * The phone subscribes to one host only — a second subscription would need a second origin, which is
 * what the proxy exists to avoid (ADR-0019). So a notice raised on the other host is handed to this
 * one over `POST /push/relay`, and this one delivers it to its own devices as if it were its own,
 * with three differences, each one a rule of D6:
 *
 * - THE MACHINE IS THE PEER'S. The service worker paints `<machine>: <title>`, and a relayed `ask`
 *   from the Mac must say `juans-macbook-pro: …`, not the name of the host that carried it.
 * - THE PATH IS REWRITTEN under `/h/<machine>`, so a tap opens the peer's screen through the proxy,
 *   inside this host's app — and `data.host` says which host a stored pending belongs to.
 * - IT IS NEVER FORWARDED AGAIN. `PushService.relay` delivers; only `send` forwards.
 *
 * The route itself — 503 before READY, 403 to anything with `Origin` — is `server.ts`'s branch 3.
 * What is decided from the BODY lives here, so it can be tested without a socket.
 */

import { z } from 'zod'
import type { ErrorCode, Logger, PushEnvelope, Timers } from '@factotum/core'
import { PEER_NAME, type PeerState, type PeerTable } from '../net/peers.ts'
import { MAX_PLAINTEXT_BYTES } from './send.ts'

/**
 * How long a forward to the peer waits (design D6). The same order as `PUSH_TIMEOUT_MS`, for the
 * same reason: `BootHandle.stop` waits for `settled()`, and a peer that fell asleep must not hang
 * this host's shutdown.
 */
export const PUSH_RELAY_TIMEOUT_MS = 5_000

/**
 * Each text field is bounded by what could ever be sent: an envelope over MAX_PLAINTEXT_BYTES is
 * not delivered by anyone (`send.ts`). The body cap (1 MiB) already bounds the whole.
 */
const text = z.string().max(MAX_PLAINTEXT_BYTES)

/**
 * Dot segments, backslashes, and the escapes that become one of them further on — in the path part
 * only; the query is the notice's own (`?ask=…`). Without this, `/h/<machine>/../../push` would still
 * be this origin, but no longer the peer's screen the prefix promises.
 */
const ESCAPES_PREFIX = /(^|\/)\.\.?(\/|$)|\\|%2e|%2f|%5c/i

const pathOnly = (path: string): string => path.split(/[?#]/, 1)[0] ?? ''

/**
 * `NotificationMessage`, validated: it is another daemon's body, and crosses HTTP like any other
 * (CLAUDE.md §1). The path must be ABSOLUTE, not protocol-relative, and unable to climb out of the
 * `/h/<machine>` it is put under.
 */
const messageSchema = z.object({
  title: text,
  body: text,
  path: text
    .regex(/^\/(?!\/)/, 'must be an absolute path')
    .refine((path) => !ESCAPES_PREFIX.test(pathOnly(path)), 'must not climb out of /h/<machine>')
    // A URL parser drops tabs and newlines silently: `/m/.\t./x` would be a `..` to sw.js.
    .refine((path) => !/[\u0000-\u0020\u007f]/.test(path), 'must not contain whitespace or control characters'),
  tag: text,
  actions: z.array(z.object({ action: text, label: text })).max(8).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  until: text.optional(),
})

/** What a peer posts: the envelope it would have sent to its own devices. */
export const relayedEnvelopeSchema = z.object({
  message: messageSchema,
  moduleId: text.nullable(),
  machine: z.string().regex(PEER_NAME, 'must be a machine name'),
})

export type RelayVerdict =
  | { readonly ok: true; readonly envelope: PushEnvelope }
  | { readonly ok: false; readonly status: 400 | 403; readonly code: ErrorCode; readonly message: string }

/**
 * Validates a relayed body and rewrites it for delivery here. `peers` are the DECLARED peers: a
 * machine that is not one of them is refused, whatever else the body says.
 */
export function acceptRelayed(body: unknown, peers: readonly { readonly name: string }[]): RelayVerdict {
  const parsed = relayedEnvelopeSchema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, status: 400, code: 'invalid-request', message: `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` }
  }

  const { message, moduleId, machine } = parsed.data
  if (!peers.some((peer) => peer.name === machine)) {
    return { ok: false, status: 403, code: 'relay-refused', message: `${machine} is not a declared peer of this host` }
  }

  // Built field by field rather than spread: `exactOptionalPropertyTypes` keeps an absent key absent.
  const { data, actions, until, ...required } = message
  return {
    ok: true,
    envelope: {
      machine,
      moduleId,
      message: {
        ...required,
        path: `/h/${machine}${message.path}`,
        // The host LAST: it is the one this daemon checked, not whatever the peer put there.
        data: { ...data, host: machine },
        ...(actions !== undefined ? { actions } : {}),
        ...(until !== undefined ? { until } : {}),
      },
    },
  }
}

/**
 * The cap of ADR-0008, checked AFTER `data.host` was added (design D6). Over it, the notice goes
 * without `data` — the title, the body and the path that opens it are what matter on a lock screen —
 * and the log says so. Still over it without `data`, `sendToAll` refuses it and logs that.
 */
export function fitRelayed(envelope: PushEnvelope, log: Logger): PushEnvelope {
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= MAX_PLAINTEXT_BYTES) return envelope
  const { data: _dropped, ...message } = envelope.message
  // The machine and nothing else: data can carry a token (ADR-0010).
  log.warn(`a notice relayed from ${envelope.machine} is over ${MAX_PLAINTEXT_BYTES} bytes; sent without its data`)
  return { ...envelope, message }
}

// ---------------------------------------------------------------------------
// The other side: this host forwarding its own notice to the peer
// ---------------------------------------------------------------------------

export interface RelayPeers {
  /** The peer table: the last probe, and the one URL towards the peer's relay. */
  readonly table: Pick<PeerTable, 'list' | 'relayUrl'>
  /** The kernel's own timers (CLAUDE.md §6): the forward's deadline is armed on them. */
  readonly timers: Timers
  /** Tests shorten it; production uses PUSH_RELAY_TIMEOUT_MS. */
  readonly timeoutMs?: number
}

/**
 * The peers a forward would reach a device through, by the LAST probe: reachable, with devices.
 * Synchronous, so `canReach` can ask it from the permission gate.
 */
export function relayTargets(table: Pick<PeerTable, 'list'>): readonly PeerState[] {
  return table.list().filter((state) => state.reachable && state.devices > 0)
}

/**
 * Posts this host's envelope to every peer `relayTargets` names. NEVER REJECTS, and never logs the
 * envelope or the URL: a notice can carry a token (ADR-0010), and the URL is in the config.
 */
export async function forwardToPeers(envelope: PushEnvelope, relay: RelayPeers, log: Logger): Promise<void> {
  await Promise.all(relayTargets(relay.table).map(async ({ name }) => await forwardTo(name, envelope, relay, log)))
}

async function forwardTo(name: string, envelope: PushEnvelope, relay: RelayPeers, log: Logger): Promise<void> {
  const target = relay.table.relayUrl(name)
  if (target === undefined) return
  const timeoutMs = relay.timeoutMs ?? PUSH_RELAY_TIMEOUT_MS
  const controller = new AbortController()
  const timer = relay.timers.setTimeout(() => controller.abort(), timeoutMs)
  try {
    // No `Origin`: Node's `fetch` adds none (measured, A2), and the relay refuses any. Redirects
    // are not followed: a peer that redirects is not a peer.
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
      redirect: 'manual',
      signal: controller.signal,
    })
    await response.body?.cancel()
    if (response.status !== 202) log.warn(`relay to ${name} answered ${response.status}`)
  } catch {
    log.warn(`relay to ${name}: ${controller.signal.aborted ? `no answer within ${timeoutMs}ms` : 'no answer'}`)
  } finally {
    timer[Symbol.dispose]()
  }
}
