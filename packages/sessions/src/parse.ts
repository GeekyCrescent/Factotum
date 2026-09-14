/**
 * `stream-json` in, four kinds of event out.
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
 * Anything the stream carries that is not one of the four kinds RETURNS NOTHING. The
 * CLI measured in block A emits `system` (init, and the hook chatter this very gate
 * generates) and `rate_limit_event`, none of which the spec listed. Dropping the
 * unrecognised is what made two unlisted types cost nothing.
 */

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

  translate(message: unknown): readonly EventInput[] {
    if (message === null || typeof message !== 'object') return []
    const record = message as { type?: unknown; subtype?: unknown; message?: unknown; is_error?: unknown; result?: unknown }

    if (record.type === 'assistant') return this.#fromAssistant(record.message)
    if (record.type === 'user') return this.#fromUser(record.message)
    if (record.type === 'result') return this.#fromResult(record)
    // `system` (including the hook chatter this gate itself causes) and
    // `rate_limit_event` land here, and so will whatever the CLI adds next.
    return []
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
      const ok = block.is_error !== true
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
