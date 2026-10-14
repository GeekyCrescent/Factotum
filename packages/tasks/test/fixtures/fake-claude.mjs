#!/usr/bin/env node
/**
 * A stand-in for `claude -p --output-format json --json-schema …`, so a capture or «What's next?»
 * runs in a test without quota or network (design D5). LAUNCHED BY PATH, never imported: it stays out
 * of `tsc`. The inbox has its own; this one answers with whatever the test put in its cwd.
 *
 * WHAT IT DOES is chosen by the file `fake-claude.modes` in its cwd — one mode per line, call N takes
 * line N and the last line repeats; no file means "ok". Every call appends its pid to
 * `fake-claude.calls` BEFORE reading stdin, so a test can find it and check it died, and writes the
 * prompt it read to `fake-claude.prompt.<N>`.
 *
 * THE ANSWER is the JSON in `fake-claude.answer` (the whole `structured_output`), or a capture parsed
 * as "parsed" with nothing deduced when there is no such file.
 *
 *   ok         answers at once
 *   wait       reads stdin, then waits for the file `fake-claude.release` in its cwd, then answers
 *   is_error   a result with is_error and api_error_status 429
 *   garbage    a line that is not JSON
 *   null       the JSON `null`: valid JSON, not a result
 *   odd-usage  a good answer whose usage fields are strings, not numbers
 *   hang       never answers (a minute), stdin unread
 *   no-stdin   exits 0 at once WITHOUT reading stdin — the EPIPE case
 *   stubborn   like "hang", but ignores SIGTERM: only SIGKILL ends it
 *   refuse     what the real CLI does with a schema it refuses: one line on stderr, exit 1
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

appendFileSync('fake-claude.calls', `${process.pid}\n`)
const calls = readFileSync('fake-claude.calls', 'utf8').trim().split('\n').length
const modes = existsSync('fake-claude.modes') ? readFileSync('fake-claude.modes', 'utf8').trim().split('\n') : ['ok']
const mode = modes[Math.min(calls, modes.length) - 1] ?? 'ok'

if (mode === 'no-stdin') process.exit(0)
if (mode === 'refuse') {
  process.stderr.write('Error: --json-schema is not a valid JSON Schema: no schema with key or ref\nsecond line\n')
  process.exit(1)
}
if (mode === 'stubborn') process.on('SIGTERM', () => undefined)
if (mode === 'hang' || mode === 'stubborn') {
  setTimeout(() => process.exit(0), 60_000)
} else {
  let prompt = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    prompt += chunk
  })
  process.stdin.on('end', () => {
    writeFileSync(`fake-claude.prompt.${calls}`, prompt)
    if (mode !== 'wait') return answer()
    const poll = setInterval(() => {
      if (!existsSync('fake-claude.release')) return
      clearInterval(poll)
      answer()
    }, 10)
  })
}

function answer() {
  if (mode === 'garbage') {
    process.stdout.write('this is not json\n')
    return
  }
  if (mode === 'null') {
    process.stdout.write('null\n')
    return
  }
  const output = existsSync('fake-claude.answer')
    ? JSON.parse(readFileSync('fake-claude.answer', 'utf8'))
    : { title: 'parsed', area: null, project: null, due: null, priority: 0 }
  const result = {
    type: 'result',
    subtype: 'success',
    is_error: mode === 'is_error',
    api_error_status: mode === 'is_error' ? 429 : null,
    duration_ms: 1234,
    num_turns: 2,
    total_cost_usd: 0.0021,
    usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 500, output_tokens: 60 },
    modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 10, outputTokens: 60, costUSD: 0.0021 } },
    ...(mode === 'is_error' ? {} : { structured_output: output }),
    ...(mode === 'odd-usage' ? { total_cost_usd: '0.01', duration_ms: 'soon', usage: 'many' } : {}),
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
