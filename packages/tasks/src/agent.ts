/**
 * `create_task`, the tool the agents of the sessions module call to put a task on the owner's board
 * (design D8; criteria 26–28, 41). Served on the sessions' MCP server through the link (design D1, D7).
 *
 * BOARD MODE ONLY HERE. The card lands in TRIAGE — the AI never puts anything on the board by itself
 * (guardrail 1) — with its session, its project, and `host: null`: the session ran on the board's host.
 *
 * AT MOST `MAX_TASKS_PER_SESSION` PER SESSION (criterion 27): the count lives on the board, raised in
 * the same write as the card, so it survives a restart. The limit is in the description, in the schema
 * and in the validator: the agent reads the first two before calling, and the third has the last word.
 *
 * NEVER THROWS (guardrail 8): every failure is an `isError` text the agent can act on. AND THE LOG
 * CARRIES IDS, never a title nor a note (criterion 41).
 */

import type { Logger } from '@factotum/core'
import { createFromAgent, type Changed, type OpContext } from './board/ops.ts'
import type { BoardStore } from './board/store.ts'
import { MAX_AREA_CHARS, MAX_NOTES_CHARS, MAX_TITLE_CHARS, parseAgentTask } from './shape.ts'
import type { AgentCall, AgentTool, AgentToolImpl, AgentToolResult, Result } from './types.ts'

export const CREATE_TASK = 'create_task'
export const MAX_TASKS_PER_SESSION = 10

const TOOL: AgentTool = {
  name: CREATE_TASK,
  description:
    "Add a task to the owner's board. It lands in Triage for the owner to accept. " +
    `At most ${MAX_TASKS_PER_SESSION} per session; after that, stop and mention the rest in your reply.`,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: MAX_TITLE_CHARS, description: 'The task, as a short action.' },
      notes: { type: 'string', maxLength: MAX_NOTES_CHARS, description: 'Context the owner needs to do it. Optional.' },
      area: { type: 'string', maxLength: MAX_AREA_CHARS, description: 'The area of the owner\'s life or work, like "BWR". Optional.' },
      due: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'The deadline, YYYY-MM-DD. Optional.' },
      priority: { type: 'integer', minimum: 0, maximum: 4, description: '1 urgent, 2 high, 3 medium, 4 low; 0 or absent for none.' },
    },
    required: ['title'],
    additionalProperties: false,
  },
}

const text = (body: string, isError: boolean): AgentToolResult => ({ content: [{ type: 'text', text: body }], ...(isError ? { isError: true as const } : {}) })

const CAPPED = text(
  `You have already created ${MAX_TASKS_PER_SESSION} tasks in this session, the most allowed. Stop creating tasks, and mention the remaining ones in your reply to the owner instead.`,
  true,
)

export interface AgentDeps {
  readonly store: BoardStore
  readonly opContext: () => OpContext
  readonly log: Logger
}

export function createAgentTools(deps: AgentDeps): AgentToolImpl {
  const create = async (input: AgentCall): Promise<AgentToolResult> => {
    if (input.name !== CREATE_TASK) return text(`The task board has no tool called ${input.name}.`, true)
    if (typeof input.raw !== 'object' || input.raw === null || Array.isArray(input.raw)) {
      return text('The arguments must be an object with at least a "title".', true)
    }
    const shaped = parseAgentTask(input.raw)
    if (!shaped.ok) return text(`The task was not added: ${shaped.field} ${shaped.reason}. Fix it and call again.`, true)

    let capped = false
    let count = 0
    const result: Result<Changed> = await deps.store.change<Changed>((board) => {
      // The cap is read on the board OF THIS CHANGE, inside the queue: ten calls at once cannot pass it.
      const used = board.agentCounts[input.sessionId] ?? 0
      if (used >= MAX_TASKS_PER_SESSION) {
        capped = true
        return { ok: false, error: { code: 'conflict', reason: 'capped' } }
      }
      count = used + 1
      return createFromAgent(board, shaped.value, { host: null, sessionId: input.sessionId, siteId: input.siteId }, deps.opContext())
    })
    if (capped) return CAPPED
    if (!result.ok) {
      deps.log.warn(`create_task from session ${input.sessionId} could not be saved: ${result.error.code}`)
      return text("The owner's board could not save the task right now; mention it in your reply instead.", true)
    }
    deps.log.info(`create_task: card ${result.value.task.id} in triage from session ${input.sessionId} (${count} of ${MAX_TASKS_PER_SESSION})`)
    return text(`Added to the owner's Triage as "${shaped.value.title}" (${count} of ${MAX_TASKS_PER_SESSION}).`, false)
  }

  return {
    tools: () => [TOOL],
    call: async (input) => {
      try {
        return await create(input)
      } catch {
        // A fixed line: the input is the agent's text, and this log carries none of it (criterion 41).
        deps.log.error(`create_task from session ${input.sessionId} failed unexpectedly`)
        return text("The owner's board could not save the task right now; mention it in your reply instead.", true)
      }
    },
  }
}
