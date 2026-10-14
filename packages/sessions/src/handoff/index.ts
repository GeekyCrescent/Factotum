/**
 * The handoff, as the engine hands it to the module's routes (spec 2026-10-07-dos-hosts, D13). Every
 * answer is a `Wire`: the routes turn it into HTTP and add nothing.
 *
 * THE RAW TEXT OF EVERY ID ARRIVES HERE, and is checked here before it becomes a path (D13, «Quién
 * valida el `hid`»): `modules/sessions/server.ts` imports only from `@factotum/core` and cannot call
 * `isSessionId`, as it already does with every `:id` of a session.
 */

import type { HandoffHost } from './host.ts'
import { isHandoffId } from './journal.ts'
import { compute, createPreviews } from './preview.ts'
import { sessionsCheck, targetProjects } from './snapshot.ts'
import { accepted, invalid, notFound, ok, type Wire } from './wire.ts'

export interface HandoffApi {
  /** `GET /handoff/projects`, for the peer and `doctor`: this host's portable projects (D7). */
  readonly projects: () => Promise<Wire>
  /** `POST /handoff/sessions-check {ids}`, for the peer: the digest of each session this host has. */
  readonly sessionsCheck: (body: unknown) => Promise<Wire>
  /** `POST /handoff/preview {to}`: 202 `{ previewId }`, and the preview runs apart (v4.3). */
  readonly startPreview: (body: unknown) => Wire
  /** `GET /handoff/preview/:previewId`. */
  readonly preview: (previewId: string) => Wire
}

/** A peer's name as `/peers/<name>/` carries it, and one this host has. */
export function peerOf(host: Pick<HandoffHost, 'peers'>, body: unknown): string | undefined {
  const to = (body as { to?: unknown } | null | undefined)?.to
  if (typeof to !== 'string' || !/^[a-z0-9-]+$/.test(to)) return undefined
  return host.peers.list().some((peer) => peer.name === to) ? to : undefined
}

export function createHandoff(host: HandoffHost): HandoffApi {
  const previews = createPreviews({
    run: async (to) => (await compute(host, to)).plan,
    timers: host.timers,
    now: host.now,
    log: host.log,
  })

  return {
    projects: async () => ok(await targetProjects(host)),
    sessionsCheck: async (body) => {
      const ids = (body as { ids?: unknown } | null | undefined)?.ids
      if (!Array.isArray(ids)) return invalid('sessions-check takes { ids: [...] }')
      return ok(await sessionsCheck(host, ids))
    },
    startPreview: (body) => {
      const to = peerOf(host, body)
      if (to === undefined) return invalid('a preview needs { to } naming a peer of this host')
      return accepted({ previewId: previews.start(to) })
    },
    preview: (previewId) => {
      if (!isHandoffId(previewId)) return invalid(`"${previewId}" is not a preview id`)
      const state = previews.get(previewId)
      return state === undefined ? notFound('no such preview; it may have expired, or the daemon restarted') : ok(state)
    },
  }
}
