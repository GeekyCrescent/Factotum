import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { capturedLog, eventually, manualTimers, PROCESS_GONE_MS, realTimers } from '../test-support.ts'
import { AUTH_REASON, isAuth, isLimit, KILL_GRACE_MS, LIMIT_REASON, resetsAtOf, runClaude, SETTLE_GRACE_MS, type RunInput } from './run.ts'

const FAKE = fileURLToPath(new URL('../../test/fixtures/fake-claude.mjs', import.meta.url))
const OUTPUT = z.object({ title: z.string() })
const TIMEOUT_MS = 30_000
/** 11:00 in Sydney (AEDT, +11). */
const NOW = new Date('2026-11-14T00:00:00.000Z')

async function rig(modes: readonly string[] = ['ok'], over: Partial<RunInput<{ title: string }>> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'factotum-jobs-run-'))
  await chmod(FAKE, 0o755)
  await writeFile(join(cwd, 'fake-claude.modes'), `${modes.join('\n')}\n`)
  const input: RunInput<{ title: string }> = {
    prompt: 'the prompt',
    jsonSchema: '{}',
    output: OUTPUT,
    model: 'sonnet',
    effort: undefined,
    cwd,
    timers: realTimers,
    signal: new AbortController().signal,
    timeoutMs: TIMEOUT_MS,
    now: () => NOW,
    bin: FAKE,
    ...over,
  }
  const pids = async (): Promise<number[]> => {
    try {
      return (await readFile(join(cwd, 'fake-claude.calls'), 'utf8')).trim().split('\n').map(Number)
    } catch {
      return []
    }
  }
  return { input, pids, cwd }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}


test('a good answer is the structured output with its usage, the cache counted apart; the prompt went by stdin', async () => {
  const { input, cwd } = await rig()
  const result = await runClaude(input)
  assert.deepEqual(result, {
    ok: true,
    value: { title: 'parsed' },
    usage: { inputTokens: 10, cacheCreationTokens: 1000, cacheReadTokens: 500, outputTokens: 60, costUsd: 0.0021, ms: 1234, model: 'claude-haiku-4-5-20251001' },
  })
  assert.equal(await readFile(join(cwd, 'fake-claude.prompt.1'), 'utf8'), 'the prompt')
})

test('usage: the three token counters come back separate, never summed (A4)', async () => {
  const { input } = await rig(['usage'])
  const result = await runClaude(input)
  assert.equal(result.ok, true)
  const usage = result.ok ? result.usage : undefined
  assert.equal(usage?.inputTokens, 11)
  assert.equal(usage?.cacheCreationTokens, 2222)
  assert.equal(usage?.cacheReadTokens, 35263)
  assert.equal(usage?.outputTokens, 777)
})

test('systemFile reaches the CLI as --append-system-prompt-file, and the prompt still goes by stdin', async () => {
  const { input, cwd } = await rig(['ok'], { systemFile: '/state/prompts/master-abc.txt' })
  assert.equal((await runClaude(input)).ok, true)
  const argv = JSON.parse(await readFile(join(cwd, 'fake-claude.args.1'), 'utf8')) as string[]
  assert.equal(argv[argv.indexOf('--append-system-prompt-file') + 1], '/state/prompts/master-abc.txt')
  assert.equal(argv.includes('the prompt'), false)
})

test('an answer that fails the schema is a failure, and the reason quotes nothing of it', async () => {
  const { input, cwd } = await rig()
  await writeFile(join(cwd, 'fake-claude.answer'), JSON.stringify({ title: 42, secret: 'the owner’s words' }))
  assert.deepEqual(await runClaude(input), { ok: false, kind: 'failed', reason: 'claude answered outside the schema' })
})

test('a schema failure is logged as a warning with the paths and codes of the issues, never a value', async () => {
  const log = capturedLog()
  const { input, cwd } = await rig(['ok'], { log: log.log, output: z.object({ title: z.string(), items: z.array(z.number()) }) })
  await writeFile(join(cwd, 'fake-claude.answer'), JSON.stringify({ title: 42, items: [1, 'the owner’s words'], secret: 'the owner’s words' }))
  assert.deepEqual(await runClaude({ ...input, prompt: 'PROMPT-DATA' }), { ok: false, kind: 'failed', reason: 'claude answered outside the schema' })
  assert.deepEqual(log.lines, ['warn jobs claude: answered outside the schema at title (invalid_type), items.1 (invalid_type)'])
})

test('a non-zero exit logs a short tail of stderr, never in the reason', async () => {
  const log = capturedLog()
  const { input } = await rig(['refuse'], { log: log.log })
  assert.deepEqual(await runClaude(input), { ok: false, kind: 'failed', reason: 'claude exited with code 1' })
  assert.equal(log.lines.length, 1)
  assert.match(log.lines[0]!, /^warn jobs claude: exited with code 1; stderr ends: .*no schema with key or ref second line$/)
  assert.ok(log.lines[0]!.length < 300)
})

test('an answer past 1 MB says it was truncated, not that it is not JSON', async () => {
  const { input } = await rig(['huge'])
  assert.deepEqual(await runClaude(input), { ok: false, kind: 'failed', reason: 'claude answered more than 1 MB: truncated, not read' })
})

test('garbage: output that is not JSON is a failure', async () => {
  const { input } = await rig(['garbage'])
  assert.deepEqual(await runClaude(input), { ok: false, kind: 'failed', reason: 'claude answered something that is not JSON' })
})

test('JSON that is not a result (null) is a failure, never a TypeError in the close handler', async () => {
  const { input } = await rig(['null'])
  assert.deepEqual(await runClaude(input), { ok: false, kind: 'failed', reason: 'claude answered something that is not a result' })
})

test('usage fields that are not numbers count as zero: the answer still lands', async () => {
  const { input } = await rig(['odd-usage'])
  const result = await runClaude(input)
  assert.deepEqual(result.ok && result.usage, {
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    ms: 0,
    model: 'claude-haiku-4-5-20251001',
  })
})

test('is_error with status 429 (exit 0, no text) is a LIMIT with no hour: the pause falls back to 30 min', async () => {
  const { input } = await rig(['is_error'])
  assert.deepEqual(await runClaude(input), { ok: false, kind: 'limit', reason: LIMIT_REASON })
})

test('limit with its hour, exit 0: resetsAt is the next 10am in Sydney plus a minute, and no CLI text in the reason', async () => {
  const { input } = await rig(['limit'])
  const result = await runClaude(input)
  assert.deepEqual(result, { ok: false, kind: 'limit', reason: LIMIT_REASON, resetsAt: '2026-11-14T23:01:00.000Z' })
  assert.doesNotMatch(LIMIT_REASON, /hit your|resets|Sydney/)
})

test('A3: a limit that exits with code 1, as the real CLI does (subtype "success"), is still a limit', async () => {
  const { input } = await rig(['limit-exit1'])
  assert.deepEqual(await runClaude(input), { ok: false, kind: 'limit', reason: LIMIT_REASON, resetsAt: '2026-11-14T23:01:00.000Z' })
})

test('a limit by its text alone (no status, no hour, exit 1) is a limit without resetsAt', async () => {
  const { input } = await rig(['limit-text'])
  assert.deepEqual(await runClaude(input), { ok: false, kind: 'limit', reason: LIMIT_REASON })
})

test('A3: an API error that is not a limit, exit 1 with its JSON, is failed WITH its status, not a bare exit code', async () => {
  const { input } = await rig(['api-error'])
  assert.deepEqual(await runClaude(input), { ok: false, kind: 'failed', reason: 'claude failed: 404' })
})

test('a logged-out CLI (measured: exit 1, subtype "success", no status, «Failed to authenticate: OAuth…») is AUTH, and its reason quotes nothing of the CLI', async () => {
  const { input } = await rig(['auth'])
  assert.deepEqual(await runClaude(input), { ok: false, kind: 'auth', reason: AUTH_REASON })
  assert.doesNotMatch(AUTH_REASON, /OAuth|expired|refreshed|authenticate/i)
})

test('a non-zero exit with nothing to read (a refused argument) is a failure with its code and nothing of stderr', async () => {
  const { input } = await rig(['refuse'])
  assert.deepEqual(await runClaude(input), { ok: false, kind: 'failed', reason: 'claude exited with code 1' })
  assert.deepEqual(await runClaude({ ...input, bin: '/usr/bin/false' }), { ok: false, kind: 'failed', reason: 'claude exited with code 1' })
})

test('EXITS WITHOUT READING STDIN: a failure with its reason, and this process lives on (EPIPE)', async () => {
  const { input } = await rig(['no-stdin'])
  const result = await runClaude({ ...input, prompt: 'x'.repeat(512 * 1024) })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.reason, /did not read the prompt \(EPIPE\)|not JSON/)
})

test('hang: killed at the timeout, on the injected timers, and the group dies', async () => {
  const manual = manualTimers()
  const { input, pids } = await rig(['hang'], { timers: manual.timers })
  const pending = runClaude(input)
  await eventually(async () => (await pids()).length === 1, 'claude started')
  assert.deepEqual(manual.pending(), [TIMEOUT_MS])
  manual.fire(TIMEOUT_MS)
  assert.deepEqual(await pending, { ok: false, kind: 'failed', reason: 'claude gave no answer within 30 s' })
  const [pid] = await pids()
  await eventually(() => !alive(pid!), 'the claude process gone', PROCESS_GONE_MS)
})

test('the signal aborted mid-run kills the group and answers stopped; already aborted never spawns', async () => {
  const run = new AbortController()
  const { input, pids } = await rig(['hang'], { signal: run.signal })
  const pending = runClaude(input)
  await eventually(async () => (await pids()).length === 1, 'claude started')
  run.abort()
  assert.deepEqual(await pending, { ok: false, kind: 'failed', reason: 'stopped' })
  const [pid] = await pids()
  await eventually(() => !alive(pid!), 'the claude process gone', PROCESS_GONE_MS)

  const done = new AbortController()
  done.abort()
  const second = await rig(['ok'], { signal: done.signal })
  assert.deepEqual(await runClaude(second.input), { ok: false, kind: 'failed', reason: 'stopped' })
  assert.deepEqual(await second.pids(), [])
})

test('a binary that is not there, or a spawn that throws, is a failure and never an exception', async () => {
  const { input } = await rig()
  const missing = await runClaude({ ...input, bin: '/nonexistent/claude' })
  assert.match(missing.ok ? '' : missing.reason, /claude could not start: .*ENOENT/)
  const nul = await runClaude({ ...input, model: 'son\u0000net' })
  assert.match(nul.ok ? '' : nul.reason, /claude could not start/)
})

test('a claude that ignores SIGTERM gets SIGKILL after the grace, and the run still settles', async () => {
  const manual = manualTimers()
  const { input, pids } = await rig(['stubborn'], { timers: manual.timers })
  const pending = runClaude(input)
  await eventually(async () => (await pids()).length === 1, 'claude started')
  const [pid] = await pids()
  await new Promise((resolve) => setTimeout(resolve, 300))
  manual.fire(TIMEOUT_MS)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(alive(pid!), true, 'SIGTERM alone did not end it')
  assert.deepEqual(manual.pending(), [KILL_GRACE_MS])
  manual.fire(KILL_GRACE_MS)
  assert.deepEqual(await pending, { ok: false, kind: 'failed', reason: 'claude gave no answer within 30 s' })
  await eventually(() => !alive(pid!), 'the stubborn claude is gone', PROCESS_GONE_MS)
})

test('a descendant in another group holding stdout: close never comes, and a last timer settles the run as timed out', async () => {
  const manual = manualTimers()
  const { input, pids } = await rig(['escape'], { timers: manual.timers })
  const pending = runClaude(input)
  await eventually(async () => (await pids()).length === 2, 'claude and its escaped grandchild started')
  const [pid, grandchild] = await pids()
  try {
    manual.fire(TIMEOUT_MS)
    await eventually(() => !alive(pid!), 'the claude process gone', PROCESS_GONE_MS)
    manual.fire(KILL_GRACE_MS)
    assert.deepEqual(manual.pending(), [SETTLE_GRACE_MS], 'a last timer, since close may never come')
    manual.fire(SETTLE_GRACE_MS)
    assert.deepEqual(await pending, { ok: false, kind: 'failed', reason: 'claude gave no answer within 30 s' })
  } finally {
    process.kill(grandchild!, 'SIGKILL')
  }
})

// ── The pure pieces ──────────────────────────────────────────────────────────────────────────────

test('isLimit: status 429, or is_error with a limit text; never subtype; a plain is_error is not a limit', () => {
  assert.equal(isLimit({ api_error_status: 429 }), true)
  assert.equal(isLimit({ is_error: true, result: 'You’ve hit your weekly limit · resets 7:50pm (Australia/Sydney)' }), true)
  assert.equal(isLimit({ is_error: true, result: "You've hit your Opus limit" }), true)
  assert.equal(isLimit({ is_error: true, result: 'Usage limit reached' }), true)
  assert.equal(isLimit({ is_error: true, result: 'monthly spend limit reached' }), true)
  assert.equal(isLimit({ is_error: false, result: 'You’ve hit your session limit', subtype: 'success' }), false)
  assert.equal(isLimit({ is_error: true, api_error_status: 404, result: 'model not found', subtype: 'success' }), false)
  assert.equal(isLimit({ is_error: true, result: 42 }), false)
})

test('isAuth: is_error with one of the login texts, any case; never subtype; a limit or another error is not', () => {
  assert.equal(isAuth({ is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' }), true)
  assert.equal(isAuth({ is_error: true, result: 'OAuth token has expired' }), true)
  assert.equal(isAuth({ is_error: true, result: 'Not logged in · Please run /login' }), true)
  assert.equal(isAuth({ is_error: true, result: 'please run /LOGIN' }), true)
  assert.equal(isAuth({ is_error: true, result: 'Invalid API key · Fix external API key' }), true)
  assert.equal(isAuth({ is_error: false, result: 'Failed to authenticate', subtype: 'error' }), false)
  assert.equal(isAuth({ is_error: true, api_error_status: 404, result: 'model not found' }), false)
  assert.equal(isAuth({ is_error: true, result: "You've hit your session limit" }), false)
  assert.equal(isAuth({ is_error: true, result: 42 }), false)
})

test('resetsAtOf: the next occurrence of that wall-clock hour in that zone, plus one minute', () => {
  const at = (text: string): string | undefined => resetsAtOf(text, NOW)
  // Already past 10am in Sydney (11:00): tomorrow.
  assert.equal(at('You’ve hit your session limit · resets 10am (Australia/Sydney)'), '2026-11-14T23:01:00.000Z')
  assert.equal(at('resets 1:50pm (Australia/Sydney)'), '2026-11-14T02:51:00.000Z')
  assert.equal(at('resets 11:10AM (Australia/Sydney)'), '2026-11-14T00:11:00.000Z')
  assert.equal(at('resets 12am (Australia/Sydney)'), '2026-11-14T13:01:00.000Z')
  assert.equal(at('resets 12pm (Australia/Sydney)'), '2026-11-14T01:01:00.000Z')
  assert.equal(at('resets 7:50pm (UTC)'), '2026-11-14T19:51:00.000Z')
})

test('resetsAtOf: no match, a bad hour or a zone Intl does not know → undefined (the 30 min pause)', () => {
  assert.equal(resetsAtOf('You’ve hit your weekly limit', NOW), undefined)
  assert.equal(resetsAtOf('resets 13pm (Australia/Sydney)', NOW), undefined)
  assert.equal(resetsAtOf('resets 10:75am (Australia/Sydney)', NOW), undefined)
  assert.equal(resetsAtOf('resets 10am (Mars/Olympus_Mons)', NOW), undefined)
  assert.equal(resetsAtOf(undefined, NOW), undefined)
})
