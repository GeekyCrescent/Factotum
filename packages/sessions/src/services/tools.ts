/**
 * The four tools the agent gets for background services (spec 2026-10-02-servicios-en-segundo-plano, D7):
 * their schemas, and the one function that runs any of them for `handleMcp`.
 *
 * ONLY INSIDE A TURN (criterion 40, guardrail 11). Without a live site every tool answers NOT_RUNNING and
 * does nothing: the MCP route does not know who is calling (risk 12), so its reach is bounded to the window
 * in which the agent can really be calling.
 *
 * NEVER THROWS FOR THE AGENT'S SAKE (guardrail 9): every failure is a result with `isError` and a text that
 * says what to fix. `handleMcp` catches what escapes anyway.
 *
 * NOTHING IS HELD. The only wait is the startup grace inside `table.start`.
 */

import type { Callers } from '../callers.ts'
import { NOT_RUNNING, toolText, type McpDeps, type McpTool, type ToolResult } from '../questions/mcp.ts'
import type { Site } from '../sites.ts'
import {
  DEFAULT_LINES,
  DEFAULT_MAX_MINUTES,
  LIST_TOOL,
  MAX_COMMAND_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_LINES,
  MAX_MAX_MINUTES,
  OUTPUT_TOOL,
  parseId,
  parseRead,
  parseStart,
  START_TOOL,
  STOP_TOOL,
  type ServiceView,
} from './shape.ts'
import type { ServiceTable } from './table.ts'

const ID_PROPERTY = { type: 'string', description: 'The id start_service or list_services returned, e.g. "s1".' } as const

/**
 * The limits go in the schema AS WELL AS in `shape.ts`: this is the only thing the agent reads before it
 * calls (the same lesson as `ask_owner`). `start_service`'s description is the one measured in tasks A3.
 */
export const SERVICE_TOOLS: readonly McpTool[] = [
  {
    name: START_TOOL,
    description:
      'Start a long-running command (a dev server, a long copy) that must keep running after your turn ends. ' +
      `factotum owns the process: it survives the end of the turn, stops by itself after max_minutes (default ${DEFAULT_MAX_MINUTES} = 8 h), ` +
      `and you can read its output later with ${OUTPUT_TOOL} or stop it with ${STOP_TOOL}.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', maxLength: MAX_COMMAND_CHARS, description: 'The command, as you would type it in a shell.' },
        description: { type: 'string', maxLength: MAX_DESCRIPTION_CHARS, description: 'What it is, in a few words. Shown to the owner.' },
        cwd: { type: 'string', description: 'Where to run it: absolute, or relative to the project. Default: the project.' },
        max_minutes: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_MAX_MINUTES,
          description: `Stop it by itself after this many minutes. Default ${DEFAULT_MAX_MINUTES}.`,
        },
      },
      required: ['command'],
    },
  },
  {
    name: OUTPUT_TOOL,
    description: 'Read the state and the last lines of output (stdout and stderr together) of a service of this session, running or ended.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID_PROPERTY,
        lines: { type: 'integer', minimum: 1, maximum: MAX_LINES, description: `How many lines, from the end. Default ${DEFAULT_LINES}.` },
      },
      required: ['id'],
    },
  },
  {
    name: STOP_TOOL,
    description: 'Stop a service of this session: SIGTERM to its whole process group, then SIGKILL if it lingers.',
    inputSchema: { type: 'object', properties: { id: ID_PROPERTY }, required: ['id'] },
  },
  {
    name: LIST_TOOL,
    description: 'List the services of this session, running and ended, with their state.',
    inputSchema: { type: 'object', properties: {} },
  },
]

/** What a service's state says, in words the agent can act on. */
export function describeState(view: ServiceView): string {
  const how = view.code !== undefined ? `code ${view.code}` : view.signal !== undefined ? view.signal : undefined
  switch (view.state) {
    case 'running':
      return `running since ${view.startedAt}`
    case 'exited':
      return `exited (${how ?? 'code 0'})`
    case 'failed':
      return how === undefined ? `failed${view.reason === undefined ? '' : `: ${view.reason}`}` : `failed (${how})`
    case 'stopped':
      return `stopped by ${view.by === 'owner' ? 'the owner' : 'you'}`
    case 'timeout':
      return `stopped after ${view.maxMinutes} minutes, its limit`
    case 'cancelled':
      return 'stopped because the session was cancelled'
    case 'shutdown':
      return `stopped: ${view.reason ?? 'factotum stopped'}`
  }
}

const line = (view: ServiceView): string => `${view.id} · ${describeState(view)} · ${view.command}`
const noSuch = (id: string): ToolResult => toolText(`There is no service ${id} in this session. list_services shows the ones there are.`, true)

export function createServiceTools(deps: {
  readonly services: ServiceTable
  readonly callers: Callers
  /**
   * The session's site ONLY while its turn runs and the engine is not stopped. `wire.ts` composes it: the
   * engine knows a site id, and resolving `cwd` needs the `Site`.
   */
  readonly liveSite: (sessionId: string) => Site | undefined
}): McpDeps['services']['call'] {
  async function start(sessionId: string, site: Site, toolUseId: string | undefined, raw: unknown): Promise<ToolResult> {
    // FIRST, so the note is consumed even when the input is refused.
    const task = deps.callers.take(toolUseId, sessionId)
    const parsed = parseStart(raw, site.path)
    if (parsed.kind === 'invalid') return toolText(parsed.reason, true)
    const outcome = await deps.services.start(sessionId, parsed.request, task)
    switch (outcome.kind) {
      case 'refused':
        return toolText(outcome.reason, true)
      case 'exited-early': {
        const tail = outcome.lines.length === 0 ? '(it printed nothing)' : outcome.lines.join('\n')
        return toolText(`The command ended during startup: ${describeState(outcome.view)}. Its last lines:\n${tail}`, true)
      }
      case 'started':
        return toolText(
          `Started service ${outcome.view.id} (pid ${outcome.view.pid}) in ${outcome.view.cwd}. It keeps running after your turn ` +
            `and stops by itself after ${outcome.view.maxMinutes} minutes. Read its output with ${OUTPUT_TOOL} { "id": "${outcome.view.id}" }; ` +
            `stop it with ${STOP_TOOL}.`,
          false,
        )
    }
  }

  async function output(sessionId: string, raw: unknown): Promise<ToolResult> {
    const parsed = parseRead(raw)
    if (parsed.kind === 'invalid') return toolText(parsed.reason, true)
    const found = await deps.services.read(sessionId, parsed.id, parsed.lines)
    if (found === undefined) return noSuch(parsed.id)
    const body = found.lines.length === 0 ? '(no output yet)' : found.lines.join('\n')
    return toolText(`${line(found.view)}\nLast ${found.lines.length} line(s):\n${body}`, false)
  }

  async function stop(sessionId: string, raw: unknown): Promise<ToolResult> {
    const parsed = parseId(raw)
    if (parsed.kind === 'invalid') return toolText(parsed.reason, true)
    const view = await deps.services.stop(sessionId, parsed.id, 'agent')
    return view === undefined ? noSuch(parsed.id) : toolText(line(view), false)
  }

  async function list(sessionId: string): Promise<ToolResult> {
    const views = await deps.services.list(sessionId)
    return toolText(views.length === 0 ? 'No services in this session.' : views.map(line).join('\n'), false)
  }

  return async ({ sessionId, toolUseId, name, raw }) => {
    const site = deps.liveSite(sessionId)
    if (site === undefined) return toolText(NOT_RUNNING, true)
    switch (name) {
      case START_TOOL:
        return await start(sessionId, site, toolUseId, raw)
      case OUTPUT_TOOL:
        return await output(sessionId, raw)
      case STOP_TOOL:
        return await stop(sessionId, raw)
      case LIST_TOOL:
        return await list(sessionId)
      default:
        return toolText(`factotum has no tool called ${name}.`, true)
    }
  }
}
