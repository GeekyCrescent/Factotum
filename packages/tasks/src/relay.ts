/**
 * Relay mode, the host that does NOT keep the board — the Mac (design D8, D12; criteria 29, 29b).
 *
 * NO BOARD HERE: a board is one list, and it lives on the host that is always on (requirements §0.1).
 * This host answers where the board is (`GET /where`, which the screen follows across the proxy), and
 * serves `create_task` to its own sessions by FORWARDING it to the board host's `agent-tasks` through
 * `ctx.peers` — `RELAY_TIMEOUT_MS`, no retry.
 *
 * THE INPUT IS CHECKED HERE FIRST, with the board's own limits: a bad call costs no trip. Whatever the
 * board host answers is handed back as it is, when it is a result; anything else — unreachable, a
 * timeout, an answer that is not a result — is one text telling the agent to tell the owner.
 *
 * WITHOUT `ctx.peers` (a context that predates it) the tool is not listed, and the log says why once
 * (R2). The log carries ids only (criterion 41).
 */

import type { Logger, PeerCaller } from '@factotum/core'
import { CREATE_TASK, TOOL_DEFINITION, toolText } from './agent.ts'
import { parseAgentTask } from './shape.ts'
import type { AgentToolImpl, AgentToolResult, Relay } from './types.ts'

export const RELAY_TIMEOUT_MS = 10_000

const UNREACHABLE = toolText("The owner's task board is unreachable; tell the owner in your reply instead. Do not try again.", true)
/** A timeout does not say whether the board filed it (`PeerResponse`): the agent must not say it did not. */
const UNKNOWN = toolText(
  "The owner's task board did not answer in time, so it is unknown whether the task was added; tell the owner in your reply. Do not try again.",
  true,
)

/** A tool result as the board host answers it: a list of text parts, and `isError` or not. */
function isResult(body: unknown): body is AgentToolResult {
  if (typeof body !== 'object' || body === null) return false
  const content = (body as { content?: unknown }).content
  return Array.isArray(content) && content.every((part) => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
}

export function createRelay(deps: { readonly relayTo: string; readonly peers: PeerCaller | undefined; readonly log: Logger }): Relay {
  let said = false
  const agent: AgentToolImpl = {
    tools: () => {
      if (deps.peers !== undefined) return [TOOL_DEFINITION]
      if (!said) {
        said = true
        deps.log.warn('tasks is in relay mode but this daemon gives modules no ctx.peers: create_task is not offered')
      }
      return []
    },
    call: async (input) => {
      if (input.name !== CREATE_TASK) return toolText(`The task board has no tool called ${input.name}.`, true)
      const shaped = parseAgentTask(input.raw)
      if (!shaped.ok) return toolText(`The task was not added: ${shaped.field} ${shaped.reason}. Fix it and call again.`, true)
      if (deps.peers === undefined) return UNREACHABLE
      const answer = await deps.peers.json(deps.relayTo, 'POST', 'agent-tasks', { ...shaped.value, sessionId: input.sessionId, siteId: input.siteId }, { timeoutMs: RELAY_TIMEOUT_MS })
      // Rebuilt, not passed through: only text parts and a boolean `isError` reach the agent.
      if (answer.ok && isResult(answer.body)) {
        const content = answer.body.content.map((part) => ({ type: 'text' as const, text: part.text }))
        return answer.body.isError === true ? { content, isError: true } : { content }
      }
      deps.log.warn(`create_task from session ${input.sessionId} could not reach the board on ${deps.relayTo} (${answer.ok ? 'not a result' : answer.reason})`)
      return !answer.ok && answer.reason === 'timeout' ? UNKNOWN : UNREACHABLE
    },
  }
  return {
    where: () => ({ mode: 'relay', host: deps.relayTo }),
    agent,
    stop: async () => undefined,
  }
}
