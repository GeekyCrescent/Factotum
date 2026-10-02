/**
 * What a background service IS, and what the agent may ask for (spec 2026-10-02-servicios-en-segundo-plano,
 * D2): the limits, the view every reader shares, and the texts the agent reads.
 *
 * RECORTA LO DE PRESENTACIÓN Y RECHAZA LO DE EJECUCIÓN. A long description is clipped, like a question's
 * text (`questions/shape.ts`); a long command is REFUSED, because clipping a command changes what it runs.
 *
 * NO I/O HERE. Whether `cwd` exists is checked by `table.start`, AFTER the entry is reserved (D5): a check
 * here would be an `await` before the reservation, which is the window the third audit closed.
 *
 * `modules/` cannot import this file (CLAUDE.md §1). `ServiceView` is declared again in
 * `modules/sessions/types.ts` (D12 bis).
 */

import { clipUnits } from '../questions/shape.ts'
import { SERVER_NAME } from '../questions/mcp.ts'
import { resolveAgainst } from '../sites.ts'

/** The owner's decision: 8 h when the agent says nothing. */
export const DEFAULT_MAX_MINUTES = 480
/** 24 h. Without a ceiling, an absurd value is "no limit", which the owner did not choose (requirements §7). */
export const MAX_MAX_MINUTES = 1_440
/** What is accepted. */
export const MAX_COMMAND_CHARS = 4_000
/** What reaches the log, like `MAX_VALUE_CHARS` for a tool's input. */
export const MAX_LOGGED_COMMAND_CHARS = 200
export const MAX_DESCRIPTION_CHARS = 120
export const DEFAULT_LINES = 50
export const MAX_LINES = 200
export const MAX_LINE_CHARS = 2_000
/** How long `start_service` waits before answering, so a command that fails at once comes back as an error. */
export const STARTUP_GRACE_MS = 2_000
/** SIGTERM, then this long, then SIGKILL. */
export const KILL_GRACE_MS = 5_000
/** Ids the agent repeats in later turns: bounded like everything that comes from outside. */
const MAX_ID_CHARS = 64

export const RESTART_REASON = 'factotum restarted'
/** What the log keeps of a `service_output` result: never the output itself (criteria 14, 30). */
export const SERVICE_OUTPUT_SUMMARY = 'output read'

export const START_TOOL = 'start_service'
export const OUTPUT_TOOL = 'service_output'
export const STOP_TOOL = 'stop_service'
export const LIST_TOOL = 'list_services'
/** What the agent, the stream and the gate call them. */
export const QUALIFIED_START = `mcp__${SERVER_NAME}__${START_TOOL}`
export const QUALIFIED_OUTPUT = `mcp__${SERVER_NAME}__${OUTPUT_TOOL}`

/**
 * The gate's reason for refusing a background `Bash` (D9). MEASURED with Haiku, Sonnet and Opus before it
 * was written down (tasks A3): all three called `start_service` on the first try, none reached for `nohup`.
 * The last sentence is A4's: a subagent with its own tool list has no MCP tools, and without it the
 * subagent suggested `nohup` to its parent.
 */
export const BACKGROUND_REDIRECT =
  'Background Bash is disabled in factotum: the CLI kills it when your turn ends. To run anything that ' +
  `must keep running (a dev server, a long copy), call ${QUALIFIED_START} with the same ` +
  'command instead. Do not use nohup or `&` as a workaround: factotum would not see or stop it. If you ' +
  `do not have ${QUALIFIED_START} (a subagent with its own tool list), do not run the command: ` +
  `finish and ask whoever launched you to call ${QUALIFIED_START} with it.`

/**
 * A `Bash` call the CLI would run in the background: `run_in_background: true` on an object, and nothing
 * else — a string `"true"` is not the CLI's flag. The gate redirects it (D9) and the stream drops it (D11).
 */
export function isBackgroundBash(toolName: unknown, toolInput: unknown): boolean {
  return (
    toolName === 'Bash' &&
    typeof toolInput === 'object' &&
    toolInput !== null &&
    (toolInput as Record<string, unknown>).run_in_background === true
  )
}

export const SERVICE_OUTCOMES = ['exited', 'failed', 'stopped', 'timeout', 'cancelled', 'shutdown'] as const
export type ServiceOutcome = (typeof SERVICE_OUTCOMES)[number]
export type StoppedBy = 'owner' | 'agent'

/** What the tools, the routes and the client see. The same for a live service and for one that ended. */
export interface ServiceView {
  readonly id: string
  /** The clipped one, as in the log. */
  readonly command: string
  readonly description: string | undefined
  readonly cwd: string
  readonly pid: number
  readonly maxMinutes: number
  readonly startedAt: string
  readonly task: string | undefined
  readonly state: 'running' | ServiceOutcome
  readonly endedAt: string | undefined
  readonly by: StoppedBy | undefined
  readonly code: number | undefined
  readonly signal: string | undefined
  readonly reason: string | undefined
}

export interface StartRequest {
  readonly command: string
  readonly description: string | undefined
  /** Already resolved against the site. */
  readonly cwd: string
  readonly maxMinutes: number
}

type Invalid = { readonly kind: 'invalid'; readonly reason: string }

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

const isPositiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1

export function parseStart(raw: unknown, sitePath: string): { kind: 'ok'; request: StartRequest } | Invalid {
  const command = field(raw, 'command')
  if (typeof command !== 'string' || command.trim() === '') {
    return { kind: 'invalid', reason: 'Give the command to run in `command`, as you would type it in a shell.' }
  }
  if (command.length > MAX_COMMAND_CHARS) {
    return {
      kind: 'invalid',
      reason: `The command is ${command.length} characters; the limit is ${MAX_COMMAND_CHARS}. Put it in a script and run the script.`,
    }
  }

  const max = field(raw, 'max_minutes')
  if (max !== undefined && (!isPositiveInt(max) || max > MAX_MAX_MINUTES)) {
    return { kind: 'invalid', reason: `max_minutes must be a whole number from 1 to ${MAX_MAX_MINUTES}, or left out for ${DEFAULT_MAX_MINUTES}.` }
  }

  const cwd = field(raw, 'cwd')
  if (cwd !== undefined && typeof cwd !== 'string') {
    return { kind: 'invalid', reason: 'cwd must be a path, absolute or relative to the project.' }
  }

  const rawDescription = field(raw, 'description')
  const description = typeof rawDescription === 'string' ? clipUnits(rawDescription.trim(), MAX_DESCRIPTION_CHARS) : ''

  return {
    kind: 'ok',
    request: {
      command,
      description: description === '' ? undefined : description,
      cwd: cwd === undefined || cwd.trim() === '' ? sitePath : resolveAgainst(sitePath, cwd),
      maxMinutes: max ?? DEFAULT_MAX_MINUTES,
    },
  }
}

export function parseId(raw: unknown): { kind: 'ok'; id: string } | Invalid {
  const id = field(raw, 'id')
  const trimmed = typeof id === 'string' ? id.trim() : ''
  if (trimmed === '' || trimmed.length > MAX_ID_CHARS) {
    return { kind: 'invalid', reason: 'Give the service id in `id`, as start_service or list_services returned it (e.g. "s1").' }
  }
  return { kind: 'ok', id: trimmed }
}

/** `lines` is presentation: over the ceiling it is clipped, not refused. */
export function parseRead(raw: unknown): { kind: 'ok'; id: string; lines: number } | Invalid {
  const id = parseId(raw)
  if (id.kind !== 'ok') return id
  const lines = field(raw, 'lines')
  if (lines === undefined) return { kind: 'ok', id: id.id, lines: DEFAULT_LINES }
  if (!isPositiveInt(lines)) return { kind: 'invalid', reason: `lines must be a whole number from 1 to ${MAX_LINES}.` }
  return { kind: 'ok', id: id.id, lines: Math.min(lines, MAX_LINES) }
}
