/**
 * The preview, ASYNCHRONOUS (spec 2026-10-07-dos-hosts, D7, v4.3): `POST /handoff/preview {to}` answers
 * 202 with a `previewId` at once, and the sheet asks `GET /handoff/preview/:previewId` every second
 * until it is `ready` or `failed`.
 *
 * WHY. The sheet is usually served by the OTHER host and reaches this one through the proxy, whose
 * `GET` is cut at 10 s — and here git runs in every project, and the peer runs git in every one of
 * its own. No budget fits under that ceiling as the repos grow, so the work runs apart and every
 * route stays short.
 *
 * IN MEMORY, NEVER ON DISK: a preview writes nothing on either host (criterion 23). One at a time
 * per peer — a second `POST` while one runs gets the same id — and each result is kept
 * HANDOFF_PREVIEW_KEEP_MS. A restart loses them: the `GET` is a 404 and the sheet asks again.
 */

import type { PeerResponse, Timers } from '@factotum/core'
import { uuidv7 } from '../id.ts'
import { HANDOFF_PEER_READ_TIMEOUT_MS, HANDOFF_PREVIEW_KEEP_MS } from './constants.ts'
import type { HandoffHost } from './host.ts'
import { plan, type Plan, type TargetProject } from './plan.ts'
import {
  ancestryOf,
  divergedOf,
  pairedCandidates,
  sessionsCheckSchema,
  sourceSnapshot,
  targetProjectsSchema,
  type SourceSnapshot,
} from './snapshot.ts'

export type PreviewFailure = 'unknown-peer' | 'peer-unreachable' | 'peer-timeout' | 'peer-error'

/** A computation that could not finish, with why. Never a half plan. */
export class PreviewError extends Error {
  readonly reason: PreviewFailure
  constructor(reason: PreviewFailure) {
    super(reason)
    this.reason = reason
  }
}

export interface Computed {
  readonly plan: Plan
  readonly source: SourceSnapshot
  readonly targets: readonly TargetProject[]
}

/** Why a call to the peer failed, as the preview says it. */
export function failureOf(answer: Extract<PeerResponse<unknown>, { ok: false }>): PreviewFailure {
  if (answer.reason === 'timeout') return 'peer-timeout'
  if (answer.reason === 'unreachable' || answer.reason === 'refused') return 'peer-unreachable'
  return 'peer-error'
}

/**
 * What would go to `to`, and what would not. The preview's work, and `POST /handoff`'s first step:
 * the two calls to the peer go with HANDOFF_PEER_READ_TIMEOUT_MS, never the 10 s default.
 */
export async function compute(host: HandoffHost, to: string, timeoutMs = HANDOFF_PEER_READ_TIMEOUT_MS): Promise<Computed> {
  if (!host.peers.list().some((peer) => peer.name === to)) throw new PreviewError('unknown-peer')
  const now = host.now()
  const source = await sourceSnapshot(host, now)

  const projectsAnswer = await host.peers.json(to, 'GET', 'handoff/projects', undefined, { timeoutMs })
  if (!projectsAnswer.ok) throw new PreviewError(failureOf(projectsAnswer))
  const targets = targetProjectsSchema.safeParse(projectsAnswer.body)
  if (!targets.success) throw new PreviewError('peer-error')
  const normalized: TargetProject[] = targets.data.map((project) => ({ ...project, branch: project.branch, head: project.head }))

  const ids = pairedCandidates(source.projects, normalized, now)
  let remote: readonly { id: string; lines: number; sha256: string }[] = []
  if (ids.length > 0) {
    const checked = await host.peers.json(to, 'POST', 'handoff/sessions-check', { ids }, { timeoutMs })
    if (!checked.ok) throw new PreviewError(failureOf(checked))
    const parsed = sessionsCheckSchema.safeParse(checked.body)
    if (!parsed.success) throw new PreviewError('peer-error')
    remote = parsed.data
  }

  const facts = { targetTipIsAncestor: await ancestryOf(host, source.projects, normalized), diverged: await divergedOf(host, remote) }
  return { plan: plan(source.projects, normalized, facts, now), source, targets: normalized }
}

export type PreviewState =
  | { readonly state: 'running' }
  | { readonly state: 'ready'; readonly plan: Plan }
  | { readonly state: 'failed'; readonly reason: PreviewFailure | 'internal' }

export interface Previews {
  /** The id of the preview for `to`: a new one, or the one already running for that peer. */
  readonly start: (to: string) => string
  /** `undefined`: no such preview, or it expired. */
  readonly get: (previewId: string) => PreviewState | undefined
}

export interface PreviewsDeps {
  readonly run: (to: string) => Promise<Plan>
  readonly timers: Timers
  readonly now: () => Date
  readonly log: HandoffHost['log']
  readonly keepMs?: number
}

export function createPreviews(deps: PreviewsDeps): Previews {
  const states = new Map<string, PreviewState>()
  const runningFor = new Map<string, string>()
  const keepMs = deps.keepMs ?? HANDOFF_PREVIEW_KEEP_MS

  const finish = (previewId: string, to: string, state: PreviewState) => {
    states.set(previewId, state)
    runningFor.delete(to)
    deps.timers.setTimeout(() => states.delete(previewId), keepMs)
  }

  return {
    start: (to) => {
      const running = runningFor.get(to)
      if (running !== undefined) return running
      const previewId = uuidv7(deps.now().getTime())
      states.set(previewId, { state: 'running' })
      runningFor.set(to, previewId)
      deps.run(to).then(
        (result) => finish(previewId, to, { state: 'ready', plan: result }),
        (error: unknown) => {
          const reason = error instanceof PreviewError ? error.reason : 'internal'
          // The reason, never the error's message: it can carry a path of this host.
          deps.log.warn(`handoff preview to ${to} failed: ${reason}`)
          finish(previewId, to, { state: 'failed', reason })
        },
      )
      return previewId
    },
    get: (previewId) => states.get(previewId),
  }
}
