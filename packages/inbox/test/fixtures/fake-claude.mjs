#!/usr/bin/env node
/**
 * A stand-in for `claude -p --output-format json --json-schema …`, so a batch can be classified in a
 * test without quota or network (spec 2026-10-05, C4). LAUNCHED BY PATH, never imported: it stays out
 * of `tsc`.
 *
 * It reads the prompt from stdin, finds the `<email id="…">` ids in it, and answers with the JSON the
 * real CLI 2.1.289 was measured writing (tasks §M, C): `type`, `subtype`, `is_error`,
 * `api_error_status`, `structured_output`, `usage`, `modelUsage`, `total_cost_usd`, `duration_ms`.
 *
 * WHAT IT DOES is chosen by the file `fake-claude.modes` in its cwd — one mode per line, call N
 * takes line N and the last line repeats; no file means "ok". Every call appends its pid to
 * `fake-claude.calls` in the cwd, BEFORE reading stdin, so a test can find it and check it died.
 *
 *   ok         every id as "info"
 *   action     every id as a high "action", with an ask, a due date and a draft
 *   omit       like "ok", without the last id
 *   bad-item   like "ok", but the first item has a category that does not exist
 *   is_error   a result with is_error and api_error_status 429
 *   garbage    a line that is not JSON
 *   hang       never answers (a minute), stdin unread
 *   no-stdin   exits 0 at once WITHOUT reading stdin — the EPIPE case (criterion 11b)
 *   refuse     what the real CLI does with a schema it refuses: one line on stderr, exit 1
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

appendFileSync('fake-claude.calls', `${process.pid}\n`)
const calls = readFileSync('fake-claude.calls', 'utf8').trim().split('\n').length
const modes = existsSync('fake-claude.modes') ? readFileSync('fake-claude.modes', 'utf8').trim().split('\n') : ['ok']
const mode = modes[Math.min(calls, modes.length) - 1] ?? 'ok'

if (mode === 'no-stdin') process.exit(0)
if (mode === 'refuse') {
  process.stderr.write('Error: --json-schema is not a valid JSON Schema: no schema with key or ref\nsecond line\n')
  process.exit(1)
}
if (mode === 'hang') {
  setTimeout(() => process.exit(0), 60_000)
} else {
  let prompt = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    prompt += chunk
  })
  process.stdin.on('end', () => answer(prompt))
}

function answer(prompt) {
  if (mode === 'garbage') {
    process.stdout.write('this is not json\n')
    return
  }
  const ids = [...prompt.matchAll(/<email id="(b\d+)"/g)].map((match) => match[1])
  const kept = mode === 'omit' ? ids.slice(0, -1) : ids
  const items = kept.map((id, index) =>
    mode === 'action'
      ? { id, category: 'action', priority: 'high', ask: `reply to ${id}`, due: '2026-10-09', why: 'a person is waiting', draft: `Hola, sobre ${id}: sí.` }
      : { id, category: mode === 'bad-item' && index === 0 ? 'urgent' : 'info', why: 'a notice' },
  )
  const result = {
    type: 'result',
    subtype: 'success',
    is_error: mode === 'is_error',
    api_error_status: mode === 'is_error' ? 429 : null,
    duration_ms: 1234,
    num_turns: 2,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 500, output_tokens: 300 },
    modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 10, outputTokens: 300, costUSD: 0.0123 } },
    ...(mode === 'is_error' ? {} : { structured_output: { items } }),
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
