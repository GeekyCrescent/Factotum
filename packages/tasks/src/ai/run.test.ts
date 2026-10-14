import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { eventually, manualTimers, realTimers } from '../test-support.ts'
import { KILL_GRACE_MS, runClaude, type RunInput } from './run.ts'

const FAKE = fileURLToPath(new URL('../../test/fixtures/fake-claude.mjs', import.meta.url))
const OUTPUT = z.object({ title: z.string() })
const TIMEOUT_MS = 30_000

async function rig(modes: readonly string[] = ['ok'], over: Partial<RunInput<{ title: string }>> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'factotum-tasks-run-'))
  await chmod(FAKE, 0o755)
  await writeFile(join(cwd, 'fake-claude.modes'), `${modes.join('\n')}\n`)
  const input: RunInput<{ title: string }> = {
    prompt: 'the prompt',
    jsonSchema: '{}',
    output: OUTPUT,
    model: 'haiku',
    effort: undefined,
    cwd,
    timers: realTimers,
    signal: new AbortController().signal,
    timeoutMs: TIMEOUT_MS,
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

test('a good answer is the structured output, validated, with its usage; the prompt went by stdin', async () => {
  const { input, cwd } = await rig()
  const result = await runClaude(input)
  assert.deepEqual(result, {
    ok: true,
    value: { title: 'parsed' },
    usage: { inputTokens: 1510, outputTokens: 60, costUsd: 0.0021, ms: 1234, model: 'claude-haiku-4-5-20251001' },
  })
  assert.equal(await readFile(join(cwd, 'fake-claude.prompt.1'), 'utf8'), 'the prompt')
})

test('an answer that fails the schema is a failure, and the reason quotes nothing of it', async () => {
  const { input, cwd } = await rig()
  await writeFile(join(cwd, 'fake-claude.answer'), JSON.stringify({ title: 42, secret: 'the owner’s words' }))
  const result = await runClaude(input)
  assert.deepEqual(result, { ok: false, reason: 'claude answered outside the schema' })
})

test('is_error is a failure with its status', async () => {
  const { input } = await rig(['is_error'])
  assert.deepEqual(await runClaude(input), { ok: false, reason: 'claude failed: 429' })
})

test('output that is not JSON is a failure', async () => {
  const { input } = await rig(['garbage'])
  assert.deepEqual(await runClaude(input), { ok: false, reason: 'claude answered something that is not JSON' })
})

test('JSON that is not a result (null, a number) is a failure, never a TypeError in the close handler', async () => {
  const { input } = await rig(['null'])
  assert.deepEqual(await runClaude(input), { ok: false, reason: 'claude answered something that is not a result' })
})

test('usage fields that are not numbers count as zero: the answer still lands', async () => {
  const { input } = await rig(['odd-usage'])
  const result = await runClaude(input)
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.usage, { inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0, model: 'claude-haiku-4-5-20251001' })
})

test('EXITS WITHOUT READING STDIN: a failure with its reason, and this process lives on (EPIPE)', async () => {
  const { input } = await rig(['no-stdin'])
  const result = await runClaude({ ...input, prompt: 'x'.repeat(512 * 1024) })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.reason, /did not read the prompt \(EPIPE\)|not JSON/)
})

test('a hung claude is killed at the timeout, on the kernel’s timers, and the group dies', async () => {
  const manual = manualTimers()
  const { input, pids } = await rig(['hang'], { timers: manual.timers })
  const pending = runClaude(input)
  await eventually(async () => (await pids()).length === 1, 'claude started')
  assert.deepEqual(manual.pending(), [TIMEOUT_MS])
  manual.fire(TIMEOUT_MS)
  assert.deepEqual(await pending, { ok: false, reason: 'claude gave no answer within 30 s' })
  const [pid] = await pids()
  await eventually(() => !alive(pid!), 'the claude process gone')
})

test('the signal aborted mid-run kills the group and answers stopped; already aborted never spawns', async () => {
  const run = new AbortController()
  const { input, pids } = await rig(['hang'], { signal: run.signal })
  const pending = runClaude(input)
  await eventually(async () => (await pids()).length === 1, 'claude started')
  run.abort()
  assert.deepEqual(await pending, { ok: false, reason: 'stopped' })
  const [pid] = await pids()
  await eventually(() => !alive(pid!), 'the claude process gone')

  const done = new AbortController()
  done.abort()
  const second = await rig(['ok'], { signal: done.signal })
  assert.deepEqual(await runClaude(second.input), { ok: false, reason: 'stopped' })
  assert.deepEqual(await second.pids(), [])
})

test('a binary that is not there, or a spawn that throws, is a failure and never an exception', async () => {
  const { input } = await rig()
  const missing = await runClaude({ ...input, bin: '/nonexistent/claude' })
  assert.match(missing.ok ? '' : missing.reason, /claude could not start: .*ENOENT/)
  const nul = await runClaude({ ...input, model: 'hai\u0000ku' })
  assert.match(nul.ok ? '' : nul.reason, /claude could not start/)
})

test('a non-zero exit, or a refusal of its arguments, is a failure with its code and nothing of stderr', async () => {
  const { input } = await rig(['refuse'])
  assert.deepEqual(await runClaude({ ...input, bin: '/usr/bin/false' }), { ok: false, reason: 'claude exited with code 1' })
  assert.deepEqual(await runClaude(input), {
    ok: false,
    // Its stderr is NOT in the reason: reasons reach the log, and stderr is not ours to vouch for (criterion 41).
    reason: 'claude exited with code 1',
  })
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
  assert.deepEqual(await pending, { ok: false, reason: 'claude gave no answer within 30 s' })
  await eventually(() => !alive(pid!), 'the stubborn claude is gone')
})
