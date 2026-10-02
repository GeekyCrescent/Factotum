/**
 * `stream-json` in, five kinds of event out.
 *
 * It does two things that are not translating, and both are inherited as requirements
 * rather than rediscovered:
 *
 * 1. NO PARTIAL MESSAGES. `--include-partial-messages` is never passed, so what
 *    arrives is whole blocks. The predecessor designed for deltas, looked at the real
 *    stream, and dropped them: every delta would be persisted into a log that is never
 *    pruned, "multiplying the size of the log by two orders of magnitude, for ever".
 *
 * 2. IT REDACTS. What survives is what says WHAT WAS DONE — the path, the command, the
 *    tool's name. The content is clipped with its original length written next to it.
 *    A `Write`'s input is the whole file and a `Read`'s result is the whole file read,
 *    so a log that kept them would be a copy of the repository.
 *    A FAILURE IS KEPT, clipped: without it the session cannot be debugged, which is
 *    the one thing the log has to be good for.
 *
 * Anything the stream carries that is not one of the five kinds RETURNS NOTHING. The
 * CLI measured in block A emits `system` (init, and the hook chatter this very gate
 * generates) and `rate_limit_event`, none of which the spec listed. Dropping the
 * unrecognised is what made two unlisted types cost nothing.
 *
 * SUBAGENTS (spec 2026-10-01-subagentes-visibles). Of `system`, exactly two subtypes are read:
 * `task_started` and `task_notification` of a `local_agent`, which become the fifth kind. And every
 * line carrying `parent_tool_use_id` is DROPPED: it is the subagent talking, and without this its
 * words and its tools land in the log as if the main agent had said and done them.
 */

import { QUALIFIED_TOOL } from './questions/mcp.ts'
import { isBackgroundBash, QUALIFIED_OUTPUT, QUALIFIED_START, SERVICE_OUTPUT_SUMMARY } from './services/shape.ts'
import type { EventInput } from './types.ts'

/** Generous: this is the conversation, which is the thing the owner actually reads. */
export const MAX_MESSAGE_CHARS = 4_000
/** Tight: these are tool arguments, and the big ones are file contents. */
export const MAX_VALUE_CHARS = 200
/** A successful result only has to say it worked. */
export const MAX_SUMMARY_CHARS = 200
/** A failure has to say enough to act on. */
export const MAX_ERROR_CHARS = 1_000

/**
 * Keys that IDENTIFY an action rather than carry its payload. Kept whole, up to a
 * bound that no real path reaches — an unbounded allowlist would be a way to smuggle a
 * file into the log through a key that happens to be named `command`.
 */
const IDENTIFYING = new Set([
  'file_path',
  'path',
  'notebook_path',
  'command',
  'pattern',
  'glob',
  'url',
  'name',
  'subagent_type',
  'description',
])
const MAX_IDENTIFYING_CHARS = 1_000

export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}… [${text.length} chars]`
}

/**
 * A tool's input with its payload taken out and its identity left in.
 *
 * Depth-bounded as well as length-bounded: a deeply nested argument would otherwise
 * recurse as far as the sender felt like.
 */
export function redactInput(input: unknown, depth = 0): unknown {
  if (depth > 3) return '…'
  if (typeof input === 'string') return clip(input, MAX_VALUE_CHARS)
  if (input === null || typeof input !== 'object') return input
  if (Array.isArray(input)) {
    const head = input.slice(0, 10).map((item) => redactInput(item, depth + 1))
    return input.length > 10 ? [...head, `… [${input.length} items]`] : head
  }

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] =
      IDENTIFYING.has(key) && typeof value === 'string'
        ? clip(value, MAX_IDENTIFYING_CHARS)
        : redactInput(value, depth + 1)
  }
  return out
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const record = block as { type?: unknown; text?: unknown }
      return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .filter((part) => part !== '')
    .join('\n')
}

interface Block {
  readonly type?: unknown
  readonly text?: unknown
  readonly name?: unknown
  readonly id?: unknown
  readonly input?: unknown
  readonly tool_use_id?: unknown
  readonly content?: unknown
  readonly is_error?: unknown
}

/**
 * Stateful, because `tool_result` only carries the id of the call it answers.
 *
 * Without the map, every result event would have to say "some tool", and a log where
 * the failures are anonymous is a log nobody can debug from.
 */
export class StreamTranslator {
  readonly #names = new Map<string, string>()
  /**
   * Calls whose tool AND result stay out of the log, by id: `ask_owner` (the `questions` event is the
   * record), `start_service` (the `service` event is) and a background `Bash` the gate redirected — its
   * deny is the agent being pointed elsewhere, not something that happened (spec 2026-10-02, D11).
   */
  readonly #dropped = new Set<string>()
  /** The subagents started and not yet ended, by task id. Lives one turn, like the translator. */
  readonly #tasks = new Set<string>()

  translate(message: unknown): readonly EventInput[] {
    if (message === null || typeof message !== 'object') return []
    const record = message as { type?: unknown; subtype?: unknown; message?: unknown; is_error?: unknown; result?: unknown }

    // Before anything else, and before `#names` learns an id: a subagent's call would otherwise leave
    // an entry its dropped result never clears.
    if (fromSubagent(record)) return []
    if (record.type === 'assistant') return this.#fromAssistant(record.message)
    if (record.type === 'user') return this.#fromUser(record.message)
    if (record.type === 'result') return this.#fromResult(record)
    if (record.type === 'system' && record.subtype === 'task_started') return this.#fromTaskStarted(record as TaskLine)
    if (record.type === 'system' && record.subtype === 'task_notification') return this.#fromTaskNotification(record as TaskLine)
    // The rest of `system` (including the hook chatter this gate itself causes, and
    // `task_updated`, which is all a Cancel leaves) and `rate_limit_event` land here,
    // and so will whatever the CLI adds next.
    return []
  }

  /**
   * Built field by field, never spread: `prompt`, `output_file` and `usage` sit on the same line and
   * must not be able to ride along (the spec's guardrail 3).
   */
  #fromTaskStarted(record: TaskLine): readonly EventInput[] {
    const task = record.task_id
    if (typeof task !== 'string' || task === '') return []
    // A Bash the subagent runs in the background is a task too; it is not a subagent.
    if (record.task_type !== 'local_agent' || record.owned_by_subagent === true) return []
    if (this.#tasks.has(task)) return []
    this.#tasks.add(task)
    return [
      {
        kind: 'subagent',
        phase: 'started',
        task,
        agent: typeof record.subagent_type === 'string' ? clip(record.subagent_type, MAX_VALUE_CHARS) : 'agent',
        description: typeof record.description === 'string' ? clip(record.description, MAX_IDENTIFYING_CHARS) : '',
        background: record.is_backgrounded === true,
      },
    ]
  }

  #fromTaskNotification(record: TaskLine): readonly EventInput[] {
    const task = record.task_id
    if (typeof task !== 'string' || !this.#tasks.has(task)) return []
    this.#tasks.delete(task)
    const ok = record.status === 'completed'
    const summary = typeof record.summary === 'string' ? record.summary : ''
    return [
      {
        kind: 'subagent',
        phase: 'ended',
        task,
        ok,
        status: typeof record.status === 'string' ? clip(record.status, MAX_VALUE_CHARS) : 'unknown',
        summary: clip(summary, ok ? MAX_SUMMARY_CHARS : MAX_ERROR_CHARS),
      },
    ]
  }

  #fromAssistant(message: unknown): readonly EventInput[] {
    const blocks = contentOf(message)
    const events: EventInput[] = []

    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        events.push({ kind: 'message', role: 'assistant', text: clip(block.text, MAX_MESSAGE_CHARS) })
        continue
      }
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        if (typeof block.id === 'string') this.#names.set(block.id, block.name)
        // The questions tool is recorded by the daemon as a `questions` event, batch and answers
        // included; the call and its result would say it twice (criterion 28). The same for a service
        // started, and a background Bash is not a call that ran. Remembered, so the result goes too.
        if (block.name === QUALIFIED_TOOL || block.name === QUALIFIED_START || isBackgroundBash(block.name, block.input)) {
          if (typeof block.id === 'string') this.#dropped.add(block.id)
          continue
        }
        events.push({ kind: 'tool', name: block.name, input: redactInput(block.input) })
      }
    }
    return events
  }

  #fromUser(message: unknown): readonly EventInput[] {
    const events: EventInput[] = []

    for (const block of contentOf(message)) {
      if (block.type !== 'tool_result') continue
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
      const name = this.#names.get(id) ?? 'tool'
      if (this.#dropped.delete(id) || name === QUALIFIED_TOOL) continue
      const ok = block.is_error !== true
      // A service's output is the disk's, NEVER the log's (criterion 30): what Claude read stays out, and
      // the owner still sees that it read. Fixed even for a failure, so no shape of it can leak.
      if (name === QUALIFIED_OUTPUT) {
        events.push({ kind: 'result', name, ok, summary: SERVICE_OUTPUT_SUMMARY })
        continue
      }
      const body = textOf(block.content)
      events.push({
        kind: 'result',
        name,
        ok,
        // A failure is the one thing worth the bytes.
        summary: clip(body, ok ? MAX_SUMMARY_CHARS : MAX_ERROR_CHARS),
      })
    }
    return events
  }

  #fromResult(record: { subtype?: unknown; is_error?: unknown; result?: unknown }): readonly EventInput[] {
    const failed = record.is_error === true || (record.subtype !== undefined && record.subtype !== 'success')
    if (!failed) return [{ kind: 'state', state: 'finished', reason: undefined }]
    const reason = typeof record.result === 'string' ? clip(record.result, MAX_ERROR_CHARS) : String(record.subtype)
    return [{ kind: 'state', state: 'failed', reason }]
  }
}

function contentOf(message: unknown): readonly Block[] {
  if (message === null || typeof message !== 'object') return []
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content as Block[]) : []
}

/**
 * A line the subagent wrote, not the agent the owner is talking to. `null` and absent are the main
 * agent's, which is what the CLI sends on its own lines (spec 2026-10-01-subagentes, §0.1).
 */
function fromSubagent(record: object): boolean {
  const parent = (record as { parent_tool_use_id?: unknown }).parent_tool_use_id
  return typeof parent === 'string' && parent !== ''
}

/** The fields of `task_started` / `task_notification` that are read. Everything else on them is not. */
interface TaskLine {
  readonly task_id?: unknown
  readonly task_type?: unknown
  readonly owned_by_subagent?: unknown
  readonly subagent_type?: unknown
  readonly description?: unknown
  readonly is_backgrounded?: unknown
  readonly status?: unknown
  readonly summary?: unknown
}
