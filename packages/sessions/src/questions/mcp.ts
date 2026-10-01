/**
 * The one MCP tool factotum serves, `ask_owner`, over the sessions module's route (spec
 * 2026-10-01-preguntas-con-opciones, D3). Three JSON-RPC messages and nothing else: no SDK, no new
 * dependency — the predecessor (Jarvis) measured that `initialize`, `tools/list` and `tools/call` are all
 * the CLI needs to call a tool.
 *
 * NO HEARTBEAT, AND THAT IS A MEASUREMENT, NOT AN OVERSIGHT. With CLI 2.1.231 a held call died after
 * ~295 s of silence whatever the server's `timeout` said, and only bytes on the wire kept it alive —
 * which here would need the kernel, because a module answers whole (ADR-0012). From 2.1.286 the CLI
 * computes the idle ceiling as max(default, server.timeout), so the `timeout` in `config.ts` lifts both:
 * a call held 2 400 s without a byte arrived (requirements §0.2, tasks A2). If a held question ever
 * dies at five minutes again with nothing touched here, the CLI has split the two ceilings again.
 *
 * NEVER THROWS FOR THE AGENT'S SAKE. A malformed batch comes back as a tool result with `isError`, the
 * one channel the agent reads and can correct; a transport error tells it nothing to fix.
 *
 * Nothing in `modules/` imports this (CLAUDE.md §1): the engine calls it from its `mcp` member.
 */

import type { McpReply } from '../types.ts'
import type { BatchOutcome } from './batches.ts'
import {
  MAX_DESCRIPTION_CHARS,
  MAX_LABEL_CHARS,
  MAX_OPTIONS,
  MAX_QUESTION_CHARS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  type Question,
} from './shape.ts'

export const SERVER_NAME = 'factotum'
export const TOOL_NAME = 'ask_owner'
/** What the agent, the stream and the gate call it. */
export const QUALIFIED_TOOL = `mcp__${SERVER_NAME}__${TOOL_NAME}`

/** What a client that names no version is told. */
const DEFAULT_PROTOCOL = '2025-06-18'

/** The tests import these instead of copying the sentences (criterion 9). */
export const UNREACHABLE = 'The owner cannot be reached right now; ask in plain text instead.'
export const NOT_RUNNING = 'This session is not running in factotum.'
/** Measured with three models before it was written down (requirements §0.4, tasks A5): none went on. */
export const EXPIRED_TEXT =
  'Nobody answered within the window. There is NO decision. Do not assume an answer and do not continue the task: ' +
  'end your turn now with a one-line note that the questions went unanswered. The owner will write when they are back.'
export const CANCELLED_TEXT = 'The session was cancelled while the questions were open. There is no decision.'
export const SHUTDOWN_TEXT = 'Factotum stopped while the questions were open. There is no decision.'

export interface ToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly isError?: true
}

export interface McpDeps {
  /** Opens the batch, tells the owner and HOLDS until it settles. The engine's; never on the facade. */
  readonly askOwner: (input: { sessionId: string; toolUseId: string | undefined; raw: unknown }) => Promise<ToolResult>
}

/**
 * The limits go in the schema AS WELL AS in `shape.ts`, and that is not duplication for its own sake:
 * this is the only thing the agent reads before calling. A limit that lives only in the validator is
 * found by failing; one in the tool's schema is respected the first time (the predecessor's lesson).
 */
const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_QUESTIONS,
      description: `1 to ${MAX_QUESTIONS} decisions. More than that is a form, not a decision.`,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: MAX_QUESTION_CHARS, description: 'The question, in one line.' },
          multiple: { type: 'boolean', description: 'true if the owner may pick several options. Default false.' },
          options: {
            type: 'array',
            minItems: MIN_OPTIONS,
            maxItems: MAX_OPTIONS,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', maxLength: MAX_LABEL_CHARS, description: 'Short, tappable text.' },
                description: {
                  type: 'string',
                  maxLength: MAX_DESCRIPTION_CHARS,
                  description: 'What choosing it implies. Optional; shown in grey under the label.',
                },
              },
              required: ['label'],
            },
          },
        },
        required: ['text', 'options'],
      },
    },
  },
  required: ['questions'],
} as const

const TOOL = {
  name: TOOL_NAME,
  description:
    'Ask the owner one or more decisions with options they can tap, instead of asking in plain text. ' +
    'The call is HELD until they answer from their phone. Each question also takes a free-text answer. ' +
    'Unanswered questions come back with "unanswered": true — that means they did NOT choose; never fill it in.',
  inputSchema: INPUT_SCHEMA,
}

export function toolText(text: string, isError: boolean): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true as const } : {}) }
}

/**
 * What the agent gets back for a settled batch. LABELS, NOT IDS: the agent never wrote the ids. Every
 * entry carries exactly one of three keys and none changes type — `chosen` is a list even with one.
 */
export function resultFor(outcome: BatchOutcome, questions: readonly Question[]): ToolResult {
  switch (outcome.kind) {
    case 'expired':
      return toolText(EXPIRED_TEXT, true)
    case 'cancelled':
      return toolText(CANCELLED_TEXT, true)
    case 'shutdown':
      return toolText(SHUTDOWN_TEXT, true)
    case 'answered': {
      const answers = questions.map((question) => {
        const answer = outcome.answers.find((a) => a.question === question.id)
        if (answer === undefined || answer.kind === 'none') return { question: question.text, unanswered: true }
        if (answer.kind === 'text') return { question: question.text, text: answer.text }
        const labels = answer.options.map((id) => question.options.find((o) => o.id === id)?.label ?? id)
        return { question: question.text, chosen: labels }
      })
      return toolText(JSON.stringify({ answers }), false)
    }
  }
}

type RpcId = string | number

function result(id: RpcId | null, value: unknown): McpReply {
  return { kind: 'body', body: { jsonrpc: '2.0', id, result: value } }
}

function failure(id: RpcId | null, code: number, message: string): McpReply {
  return { kind: 'body', body: { jsonrpc: '2.0', id, error: { code, message } } }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** One JSON-RPC message from the CLI, for the session named in the URL. */
export async function handleMcp(deps: McpDeps, sessionId: string, message: unknown): Promise<McpReply> {
  const rpc = record(message)
  if (rpc === undefined) return failure(null, -32600, 'not a JSON-RPC message')

  // No id is a notification (`notifications/initialized` and friends): accepted, never answered.
  const id = rpc.id
  if (typeof id !== 'string' && typeof id !== 'number') return { kind: 'accepted' }

  const params = record(rpc.params)
  switch (rpc.method) {
    case 'initialize': {
      const asked = params?.protocolVersion
      return result(id, {
        protocolVersion: typeof asked === 'string' ? asked : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: '0.0.0' },
      })
    }
    case 'ping':
      return result(id, {})
    case 'tools/list':
      return result(id, { tools: [TOOL] })
    case 'tools/call': {
      if (params?.name !== TOOL_NAME) return failure(id, -32602, `this session has no tool called ${String(params?.name)}`)
      const toolUseId = record(params._meta)?.['claudecode/toolUseId']
      try {
        return result(
          id,
          await deps.askOwner({ sessionId, toolUseId: typeof toolUseId === 'string' ? toolUseId : undefined, raw: params.arguments }),
        )
      } catch (error) {
        const why = error instanceof Error ? error.message : 'unknown error'
        return result(id, toolText(`factotum could not ask the owner (${why}); ask in plain text instead.`, true))
      }
    }
    default:
      // `server/discover` included: the CLI sends it and does not need it (requirements §0.1).
      return failure(id, -32601, `method not implemented: ${String(rpc.method)}`)
  }
}
