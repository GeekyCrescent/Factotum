/**
 * The push of a DEFERRED reply (design D3 «Respuesta mientras el `initial` está `sending`»: «el push de
 * `interview`/`offer` sale entonces»; §M of E1: «el push de un `interview` diferido es de Q»).
 *
 * `send/deferred.ts` applies the replies written while the initial was in flight, in the `tx` that
 * closes the send; this wraps it as the sender's `applyDeferred` seam and, for each reply it applied
 * (cited by a `reply-applied` without `skipped`) of class `interview` or `offer`, asks for the push of
 * Q4 (`replyPush`). The push itself goes after the commit (`facade/layers.ts`).
 *
 * The opening `tx` of a start (`applyDeferredRepliesOnStart`) is not wrapped: a reply deferred across a
 * restart lands without its push — the event stays in the tracker, as with no device (D16).
 */

import { applyDeferredReplies } from '../send/deferred.ts'
import type { Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import type { Result } from '../types.ts'
import { replyPush, type ApplyDeps } from './apply.ts'

export function applyDeferredWithPush(push: ApplyDeps['push']): typeof applyDeferredReplies {
  return (q: Queries, applicationId: string, at: Date): Result<number> => {
    const pending = repo.pendingDeferredReplies(q, applicationId)
    const applied = applyDeferredReplies(q, applicationId, at)
    if (!applied.ok || applied.value === 0) return applied
    const app = repo.getApplication(q, applicationId)
    if (app === undefined) return applied
    const cited = new Map(
      repo
        .eventsOf(q, applicationId)
        .filter((e) => e.kind === 'reply-applied' && typeof e.data.replyEventId === 'string')
        .map((e) => [e.data.replyEventId as string, e.data.skipped === undefined]),
    )
    const company = repo.getCompany(q, app.companyId)?.name ?? ''
    for (const reply of pending) {
      const cls = reply.data.class
      if ((cls !== 'interview' && cls !== 'offer') || cited.get(reply.id) !== true) continue
      push(typeof reply.data.key === 'string' ? reply.data.key : reply.id, replyPush(app.id, company, cls))
    }
    return applied
  }
}
