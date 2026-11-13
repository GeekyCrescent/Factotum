#!/usr/bin/env node
/**
 * A stand-in for `claude -p --output-format json --json-schema …`, so a generation runs in a test
 * without quota or network (design D10). COPIED FROM packages/tasks/test/fixtures/fake-claude.mjs
 * (S11), plus the modes of D10/A3: `limit` (exit 0 and exit 1), `limit-text`, `api-error`, `usage`.
 * LAUNCHED BY PATH, never imported: it stays out of `tsc`.
 *
 * WHAT IT DOES is chosen by the file `fake-claude.modes` in its cwd — one mode per line, call N takes
 * line N and the last line repeats; no file means "ok". Every call appends its pid to
 * `fake-claude.calls` BEFORE reading stdin, so a test can find it and check it died, writes its argv
 * to `fake-claude.args.<N>` (JSON) and the prompt it read to `fake-claude.prompt.<N>`.
 *
 * THE ANSWER is the JSON in `fake-claude.answer` (the whole `structured_output`), or `{ title: 'parsed', … }`.
 *
 *   ok           answers at once
 *   wait         reads stdin, then waits for the file `fake-claude.release` in its cwd, then answers
 *   is_error     a result with is_error and api_error_status 429, no text, exit 0 (tasks' own)
 *   limit        is_error, 429, «You've hit your session limit · resets 10am (Australia/Sydney)», exit 0
 *   limit-exit1  THE REAL CLI (A3): the same limit with subtype "success",
 *                terminal_reason "api_error" — and exit code 1
 *   limit-text   is_error, no status, «You've hit your weekly limit» (no hour), exit 1
 *   api-error    an error that is not a limit, as the real CLI: 404, subtype "success", exit 1
 *   usage        a good answer with the three token counters apart (11 / 2222 / 35263, 777 out)
 *   garbage      a line that is not JSON
 *   null         the JSON `null`: valid JSON, not a result
 *   odd-usage    a good answer whose usage fields are strings, not numbers
 *   hang         never answers (a minute), stdin unread
 *   no-stdin     exits 0 at once WITHOUT reading stdin — the EPIPE case
 *   stubborn     like "hang", but ignores SIGTERM: only SIGKILL ends it
 *   refuse       what the real CLI does with a schema it refuses: one line on stderr, exit 1
 *   escape       like "hang", and starts a grandchild IN ANOTHER GROUP that holds stdout open: killing
 *                the group never brings `close`. Its pid goes to `fake-claude.calls` too; the test kills it
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

appendFileSync('fake-claude.calls', `${process.pid}\n`)
const calls = readFileSync('fake-claude.calls', 'utf8').trim().split('\n').length
writeFileSync(`fake-claude.args.${calls}`, JSON.stringify(process.argv.slice(2)))
const modes = existsSync('fake-claude.modes') ? readFileSync('fake-claude.modes', 'utf8').trim().split('\n') : ['ok']
const mode = modes[Math.min(calls, modes.length) - 1] ?? 'ok'

const SESSION_LIMIT = "You've hit your session limit · resets 10am (Australia/Sydney)"

/** The error results, as the CLI writes them; `exit` is the code it leaves with. */
const ERRORS = {
  is_error: { exit: 0, fields: { api_error_status: 429 } },
  limit: { exit: 0, fields: { api_error_status: 429, result: SESSION_LIMIT } },
  'limit-exit1': { exit: 1, fields: { api_error_status: 429, terminal_reason: 'api_error', result: SESSION_LIMIT } },
  'limit-text': { exit: 1, fields: { api_error_status: null, terminal_reason: 'api_error', result: "You've hit your weekly limit" } },
  'api-error': { exit: 1, fields: { api_error_status: 404, terminal_reason: 'api_error', result: 'There is an issue with the selected model.' } },
}

if (mode === 'no-stdin') process.exit(0)
if (mode === 'refuse') {
  process.stderr.write('Error: --json-schema is not a valid JSON Schema: no schema with key or ref\nsecond line\n')
  process.exit(1)
}
if (mode === 'stubborn') process.on('SIGTERM', () => undefined)
if (mode === 'escape') {
  const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true })
  grandchild.unref()
  appendFileSync('fake-claude.calls', `${grandchild.pid}\n`)
}
if (mode === 'hang' || mode === 'stubborn' || mode === 'escape') {
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
  const error = ERRORS[mode]
  const output = existsSync('fake-claude.answer')
    ? JSON.parse(readFileSync('fake-claude.answer', 'utf8'))
    : { title: 'parsed', area: null, project: null, due: null, priority: 0 }
  const usage =
    mode === 'usage'
      ? { input_tokens: 11, cache_creation_input_tokens: 2222, cache_read_input_tokens: 35263, output_tokens: 777 }
      : { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 500, output_tokens: 60 }
  const result = {
    type: 'result',
    // A3: the real CLI says "success" even on an API error; nothing should read it.
    subtype: 'success',
    is_error: error !== undefined,
    api_error_status: null,
    duration_ms: 1234,
    num_turns: 2,
    total_cost_usd: 0.0021,
    usage,
    modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 10, outputTokens: 60, costUSD: 0.0021 } },
    ...(error === undefined ? { structured_output: output } : error.fields),
    ...(mode === 'odd-usage' ? { total_cost_usd: '0.01', duration_ms: 'soon', usage: 'many' } : {}),
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (error !== undefined) process.exitCode = error.exit
}
