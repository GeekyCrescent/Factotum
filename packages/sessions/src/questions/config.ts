/**
 * The `--mcp-config` file, one per session, next to its `settings.json` (spec
 * 2026-10-01-preguntas-con-opciones, D4).
 *
 * THE SESSION IS IN THE URL. It is what tells the route who is calling: the MCP messages themselves
 * carry no session id. Same base as the hook (`setup.hookUrl()`): loopback, this daemon's port.
 *
 * THE TIMEOUT IS THE HOOK'S, DERIVED. With CLI 2.1.286 a server's `timeout` lifts both the wall clock
 * and the idle ceiling (requirements §0.2); with 2.1.231 it lifted only the first, and the predecessor
 * needed a heartbeat for the second. If the CLI ever separates them again, a held question dies at five
 * minutes — the fix is a heartbeat, and that touches the kernel (risk 1 of the spec).
 *
 * `alwaysLoad: true`, or the CLI defers the tool behind `ToolSearch` and an agent nobody told about it
 * spends a turn looking (measured, tasks A4). Its cost — holding startup up to 5 s — is nil here: the
 * server is this daemon, already up.
 */

import { HOOK_TIMEOUT_SECONDS } from '../permissions/settings.ts'
import { SERVER_NAME } from './mcp.ts'

export const MCP_ROUTE = '/modules/sessions/mcp'

export interface McpConfig {
  readonly mcpServers: {
    readonly [SERVER_NAME]: {
      readonly type: 'http'
      readonly url: string
      readonly timeout: number
      readonly alwaysLoad: true
    }
  }
}

export function mcpConfig(baseUrl: string, sessionId: string): McpConfig {
  return {
    mcpServers: {
      [SERVER_NAME]: {
        type: 'http',
        url: `${baseUrl.replace(/\/+$/, '')}${MCP_ROUTE}/${sessionId}`,
        timeout: HOOK_TIMEOUT_SECONDS * 1000,
        alwaysLoad: true,
      },
    },
  }
}

export function serializeMcpConfig(config: McpConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}
