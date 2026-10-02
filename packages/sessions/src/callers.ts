/**
 * Which subagent made a call, by `tool_use_id` (spec 2026-10-02-servicios-en-segundo-plano, D8).
 *
 * The MCP call does not say who is calling (spec 2026-10-01-preguntas-con-opciones, §0.3); the hook does,
 * and it runs first. So the gate notes it here and the tool takes it. It used to be a map private to the
 * questions; `ask_owner` and `start_service` need it now, so it lives on its own and both share it.
 *
 * Who cleans it: the questions, as before — `closeSession` forgets a session and `closeAll` clears, and
 * both already run at every end of a session and in `stop()`.
 */

import { QUALIFIED_TOOL } from './questions/mcp.ts'
import { QUALIFIED_START } from './services/shape.ts'

export const ATTRIBUTED_TOOLS: ReadonlySet<string> = new Set([QUALIFIED_TOOL, QUALIFIED_START])

export interface Callers {
  /** From the gate, after its decision and without touching it. Only ATTRIBUTED_TOOLS called by a subagent. */
  readonly note: (input: { toolName: string; toolUseId: unknown; agentId: string | undefined; sessionId: string }) => void
  /**
   * Reads and deletes. The subagent ONLY if the same session noted it: the check `askOwner` used to make
   * itself, here for both consumers.
   */
  readonly take: (toolUseId: string | undefined, sessionId: string) => string | undefined
  readonly forgetSession: (sessionId: string) => void
  readonly clear: () => void
}

export function createCallers(): Callers {
  const noted = new Map<string, { readonly agentId: string; readonly sessionId: string }>()
  return {
    note: ({ toolName, toolUseId, agentId, sessionId }) => {
      if (!ATTRIBUTED_TOOLS.has(toolName) || agentId === undefined || typeof toolUseId !== 'string') return
      noted.set(toolUseId, { agentId, sessionId })
    },
    take: (toolUseId, sessionId) => {
      if (toolUseId === undefined) return undefined
      const found = noted.get(toolUseId)
      noted.delete(toolUseId)
      return found?.sessionId === sessionId ? found.agentId : undefined
    },
    forgetSession: (sessionId) => {
      for (const [toolUseId, caller] of noted) if (caller.sessionId === sessionId) noted.delete(toolUseId)
    },
    clear: () => noted.clear(),
  }
}
