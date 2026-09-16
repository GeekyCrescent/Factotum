/**
 * What a phone is told when a turn ends. One builder, used by the three places that write a
 * terminal state — `finalize`, `stop` and `reconcile` — so they cannot drift into saying three
 * different things.
 *
 * EVERYTHING HERE LEAVES THE TAILNET, through the browser vendor's push service (ADR-0008). So a
 * notice carries the least that is enough to decide: the state, the site, and a reason ONLY when
 * it is one of this package's own fixed sentences. A failed turn's reason is the agent's stderr,
 * which can hold paths and anything the process printed — that stays on the screen.
 */

import type { NotificationMessage } from '@factotum/core'
import type { SessionState } from './types.ts'

/**
 * Reasons that are safe to send because this package wrote them, word for word. Anything else —
 * stderr, a message relayed from the CLI's stream — is not sent.
 */
export function noticeFor(
  sessionId: string,
  siteId: string,
  state: SessionState,
  reason: string | undefined,
  knownReasons: ReadonlySet<string>,
): NotificationMessage {
  const said = reason !== undefined && knownReasons.has(reason) ? ` · ${reason}` : ''
  return {
    title: state,
    body: `${siteId}${said}`,
    // THE SESSION ID, so if two paths ever announced the same end, the phone collapses them
    // into one instead of buzzing twice.
    tag: sessionId,
    path: `/m/sessions/${sessionId}`,
  }
}
