/**
 * The link between `tasks` and the sessions MCP (design D1): an object that starts empty and is
 * filled late.
 *
 * `sessions` starts before or after `tasks` depending on the order of the list, and reads the tools
 * on EVERY `tools/list`, never at start — the shape of `hookUrl` in `main.ts`, there for the same
 * reason. `tasks` fills it LAST in `start` and clears it in `stop`, so while `tasks` is off, starting
 * or failed, `create_task` is simply not in the list (criterion 2), with no error to explain.
 */

import type { AgentToolImpl, AgentToolResult, TasksLink } from './types.ts'

const UNAVAILABLE: AgentToolResult = {
  content: [{ type: 'text', text: "The owner's task board is not available right now; mention the task in your reply instead." }],
  isError: true,
}

export function createTasksLink(): TasksLink {
  let impl: AgentToolImpl | undefined
  return {
    family: {
      tools: () => impl?.tools() ?? [],
      // A call that races a `stop` lands here: answered, never thrown (guardrail 8).
      call: async (input) => (impl === undefined ? UNAVAILABLE : impl.call(input)),
    },
    fill: (next) => {
      impl = next
    },
    clear: () => {
      impl = undefined
    },
  }
}
