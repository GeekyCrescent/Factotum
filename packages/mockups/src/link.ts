/**
 * The link between `mockups` and the sessions MCP (design D1), the shape of `tasks`' own
 * (`packages/tasks/src/link.ts`, whose header explains it): it starts empty, `mockups` fills it LAST
 * in `start` and clears it in `stop`, and `sessions` reads it on every `tools/list`.
 */

import type { AgentToolImpl, AgentToolResult, MockupsLink } from './types.ts'

const UNAVAILABLE: AgentToolResult = {
  content: [{ type: 'text', text: 'The mockups module is not available right now. Tell the owner in your reply that the stage is done and could not be submitted.' }],
  isError: true,
}

export function createMockupsLink(): MockupsLink {
  let impl: AgentToolImpl | undefined
  return {
    family: {
      tools: () => impl?.tools() ?? [],
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
