import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { clip, redactInput, StreamTranslator, MAX_VALUE_CHARS } from './parse.ts'
import type { EventInput } from './types.ts'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'one-turn-write.jsonl')

/** The real CLI stream captured in block A, sanitised. No quota is spent here. */
function fixtureMessages(): readonly unknown[] {
  return readFileSync(FIXTURE, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown)
}

function translateAll(messages: readonly unknown[]): readonly EventInput[] {
  const translator = new StreamTranslator()
  return messages.flatMap((message) => translator.translate(message))
}

// ---------------------------------------------------------------------------
// Against the real stream
// ---------------------------------------------------------------------------

test('a real one-turn session translates to the four kinds and nothing else', () => {
  const events = translateAll(fixtureMessages())
  const kinds = events.map((e) => e.kind)
  assert.deepEqual(kinds, ['tool', 'result', 'message', 'state'])
})

test('the tool event keeps the tool name and the path it wrote to', () => {
  const [tool] = translateAll(fixtureMessages())
  assert.equal(tool?.kind === 'tool' ? tool.name : '', 'Write')
  assert.equal(
    tool?.kind === 'tool' ? (tool.input as { file_path?: string }).file_path : '',
    '/work/site/inside.txt',
  )
})

test('the result event knows WHICH tool it answers, by tool_use_id', () => {
  // The stream only carries the id on a result, so without the map every failure in
  // the log would be anonymous.
  const events = translateAll(fixtureMessages())
  const result = events.find((e) => e.kind === 'result')
  assert.equal(result?.kind === 'result' ? result.name : '', 'Write')
  assert.equal(result?.kind === 'result' ? result.ok : false, true)
})

test('the session ends in a finished state event', () => {
  const events = translateAll(fixtureMessages())
  const last = events.at(-1)
  assert.equal(last?.kind === 'state' ? last.state : '', 'finished')
})

test('system, init, hook chatter and rate_limit_event all produce NOTHING', () => {
  // Block A found `system` and `rate_limit_event` in the real stream, neither of them
  // in the spec. Dropping the unrecognised is what made that cost nothing — and the
  // hook chatter is this gate's own noise, which must never reach the log.
  const translator = new StreamTranslator()
  const ignored = fixtureMessages().filter((m) => {
    const type = (m as { type?: string }).type
    return type === 'system' || type === 'rate_limit_event'
  })
  assert.notEqual(ignored.length, 0)
  for (const message of ignored) assert.deepEqual(translator.translate(message), [])
})

test('a message type the CLI has not invented yet produces nothing instead of throwing', () => {
  const translator = new StreamTranslator()
  assert.deepEqual(translator.translate({ type: 'something_new', payload: {} }), [])
  assert.deepEqual(translator.translate(null), [])
  assert.deepEqual(translator.translate('not an object'), [])
  assert.deepEqual(translator.translate({ type: 'assistant' }), [])
})

// ---------------------------------------------------------------------------
// Criterion 9 — complete messages, not tokens
// ---------------------------------------------------------------------------

test('one assistant text block makes exactly ONE message event, not one per token', () => {
  const text = 'Created the file. It contains BANANA, which is what you asked for.'
  const translator = new StreamTranslator()
  const events = translator.translate({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.kind === 'message' ? events[0].text : '', text)
})

test('the number of message events equals the number of TEXT BLOCKS in the stream', () => {
  const messages = fixtureMessages()
  const blocks = messages
    .filter((m) => (m as { type?: string }).type === 'assistant')
    .flatMap((m) => ((m as { message?: { content?: unknown[] } }).message?.content ?? []))
    .filter((b) => (b as { type?: string }).type === 'text').length

  const produced = translateAll(messages).filter((e) => e.kind === 'message').length
  assert.equal(produced, blocks)
  assert.notEqual(blocks, 0)
})

test('an empty or whitespace text block is not an event', () => {
  const translator = new StreamTranslator()
  assert.deepEqual(
    translator.translate({ type: 'assistant', message: { content: [{ type: 'text', text: '  \n ' }] } }),
    [],
  )
})

// ---------------------------------------------------------------------------
// Criterion 10 — the log does not carry the content
// ---------------------------------------------------------------------------

test('a 50 KB Write keeps the PATH and loses the content, with the length recorded', () => {
  const content = 'x'.repeat(50_000)
  const translator = new StreamTranslator()
  const [event] = translator.translate({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/work/site/big.txt', content } },
      ],
    },
  })

  assert.equal(event?.kind, 'tool')
  const input = event?.kind === 'tool' ? (input0(event.input)) : { file_path: '', content: '' }
  assert.equal(input.file_path, '/work/site/big.txt')
  assert.equal(input.content.length < 300, true)
  // The original length is written down, so the log says how much was NOT kept.
  assert.match(input.content, /\[50000 chars\]$/)

  // And the whole event, serialised, is orders of magnitude smaller than the write.
  assert.equal(JSON.stringify(event).length * 50 < content.length, true)
})

function input0(input: unknown): { file_path: string; content: string } {
  const record = input as { file_path?: string; content?: string }
  return { file_path: record.file_path ?? '', content: record.content ?? '' }
}

test('a Read result is summarised, not stored', () => {
  const translator = new StreamTranslator()
  translator.translate({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't9', name: 'Read', input: { file_path: '/work/site/a.md' } }] },
  })
  const [event] = translator.translate({
    type: 'user',
    message: { content: [{ tool_use_id: 't9', type: 'tool_result', content: 'y'.repeat(40_000) }] },
  })
  assert.equal(event?.kind === 'result' ? event.summary.length < 300 : false, true)
})

test('a FAILING result is kept — clipped, but kept — because otherwise nothing is debuggable', () => {
  const translator = new StreamTranslator()
  translator.translate({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'make' } }] },
  })
  const [event] = translator.translate({
    type: 'user',
    message: {
      content: [
        { tool_use_id: 't2', type: 'tool_result', is_error: true, content: `error: ${'d'.repeat(5_000)}` },
      ],
    },
  })
  assert.equal(event?.kind === 'result' ? event.ok : true, false)
  const summary = event?.kind === 'result' ? event.summary : ''
  assert.match(summary, /^error: d+/)
  // Longer than a success summary, shorter than what came in.
  assert.equal(summary.length > 500 && summary.length < 2_000, true)
})

test('an identifying key survives whole; an ordinary long value does not', () => {
  const redacted = redactInput({
    command: 'git log --oneline -20',
    file_path: '/a/very/long/but/entirely/reasonable/path/to/a/file.ts',
    old_string: 'z'.repeat(5_000),
  }) as Record<string, string>

  assert.equal(redacted['command'], 'git log --oneline -20')
  assert.equal(redacted['file_path'], '/a/very/long/but/entirely/reasonable/path/to/a/file.ts')
  assert.match(redacted['old_string'] ?? '', /\[5000 chars\]$/)
})

test('even an identifying key is bounded, so `command` is not a way to smuggle a file in', () => {
  const redacted = redactInput({ command: 'q'.repeat(9_000) }) as Record<string, string>
  assert.equal((redacted['command'] ?? '').length < 1_100, true)
})

test('redaction is depth-bounded and array-bounded', () => {
  const deep = { a: { b: { c: { d: { e: 'too far' } } } } }
  assert.deepEqual(redactInput(deep), { a: { b: { c: { d: '…' } } } })

  const long = redactInput({ items: Array.from({ length: 40 }, (_, i) => i) }) as { items: unknown[] }
  assert.equal(long.items.length, 11)
  assert.equal(long.items.at(-1), '… [40 items]')
})

test('non-string scalars pass through untouched', () => {
  assert.deepEqual(redactInput({ n: 1, b: true, z: null }), { n: 1, b: true, z: null })
})

test('clip leaves short text alone and annotates long text', () => {
  assert.equal(clip('short', MAX_VALUE_CHARS), 'short')
  assert.match(clip('l'.repeat(500), MAX_VALUE_CHARS), /^l{200}… \[500 chars\]$/)
})

// ---------------------------------------------------------------------------
// The terminal state
// ---------------------------------------------------------------------------

test('a result whose subtype is not success becomes a FAILED state with the reason', () => {
  const translator = new StreamTranslator()
  const [event] = translator.translate({ type: 'result', subtype: 'error_max_turns', result: 'ran out of turns' })
  assert.equal(event?.kind === 'state' ? event.state : '', 'failed')
  assert.equal(event?.kind === 'state' ? event.reason : '', 'ran out of turns')
})

test('a result flagged is_error becomes failed even when the subtype says success', () => {
  const translator = new StreamTranslator()
  const [event] = translator.translate({ type: 'result', subtype: 'success', is_error: true, result: 'boom' })
  assert.equal(event?.kind === 'state' ? event.state : '', 'failed')
})

test('a tool_result for a call nobody saw is still recorded, under a generic name', () => {
  const translator = new StreamTranslator()
  const [event] = translator.translate({
    type: 'user',
    message: { content: [{ tool_use_id: 'unknown', type: 'tool_result', content: 'fine' }] },
  })
  assert.equal(event?.kind === 'result' ? event.name : '', 'tool')
})
