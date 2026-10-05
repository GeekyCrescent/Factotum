import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eventually, manualTimers, realTimers } from '../test-support.ts'
import type { PromptMail } from './prompt.ts'
import { BATCH_TIMEOUT_MS, classifyBatch, KILL_GRACE_MS, type BatchInput } from './run.ts'

const FAKE = fileURLToPath(new URL('../../test/fixtures/fake-claude.mjs', import.meta.url))

function mails(count: number, bodyChars = 100): PromptMail[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `b${index}`,
    account: 'Gmail',
    from: 'Ana <ana@example.com>',
    date: '2026-10-06T07:00:00.000Z',
    subject: `subject ${index}`,
    body: 'x'.repeat(bodyChars),
    unsubscribe: false,
    attachments: 0,
  }))
}

async function rig(modes: readonly string[] = ['ok'], over: Partial<BatchInput> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'factotum-inbox-run-'))
  await writeFile(join(cwd, 'fake-claude.modes'), `${modes.join('\n')}\n`)
  const input: BatchInput = {
    mails: mails(3),
    today: '2026-10-06',
    model: 'haiku',
    effort: undefined,
    cwd,
    signal: new AbortController().signal,
    timers: realTimers,
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
  return { input, pids }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('a good batch gives one verdict per id, and its usage', async () => {
  const { input } = await rig(['action'])
  const result = await classifyBatch(input)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual([...result.verdicts.keys()], ['b0', 'b1', 'b2'])
  assert.deepEqual(result.verdicts.get('b0'), {
    category: 'action',
    priority: 'high',
    ask: 'reply to b0',
    due: '2026-10-09',
    why: 'a person is waiting',
    draft: 'Hola, sobre b0: sí.',
  })
  assert.deepEqual(result.usage, { inputTokens: 1510, outputTokens: 300, costUsd: 0.0123, ms: 1234, model: 'claude-haiku-4-5-20251001' })
})

test('an omitted id is simply absent — the caller leaves it unclassified (criterion 12)', async () => {
  const { input } = await rig(['omit'])
  const result = await classifyBatch(input)
  assert.deepEqual(result.ok && [...result.verdicts.keys()], ['b0', 'b1'])
})

test('one item that fails the schema loses that mail only, and an id not in the batch is ignored', async () => {
  const { input } = await rig(['bad-item'])
  const result = await classifyBatch({ ...input, mails: mails(3).slice(0, 2) })
  assert.deepEqual(result.ok && [...result.verdicts.keys()], ['b1'])
})

test('is_error is a failure with its status', async () => {
  const { input } = await rig(['is_error'])
  assert.deepEqual(await classifyBatch(input), { ok: false, reason: 'claude failed: 429' })
})

test('output that is not JSON is a failure', async () => {
  const { input } = await rig(['garbage'])
  assert.deepEqual(await classifyBatch(input), { ok: false, reason: 'claude answered something that is not JSON' })
})

test('EXITS WITHOUT READING 160 KB OF STDIN: the batch fails with its reason and this process lives on (criterion 11b)', async () => {
  const { input } = await rig(['no-stdin'])
  const result = await classifyBatch({ ...input, mails: mails(40, 4_000) })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /did not read the prompt \(EPIPE\)|not JSON/)
  // Reaching this line IS the assertion that matters: an unhandled EPIPE would have ended the test process.
})

test('a hung claude is killed at the timeout, on the kernel’s timers, and the batch fails', async () => {
  const manual = manualTimers()
  const { input, pids } = await rig(['hang'], { timers: manual.timers })
  const pending = classifyBatch(input)
  await eventually(async () => (await pids()).length === 1, 'claude started')
  assert.deepEqual(manual.pending(), [BATCH_TIMEOUT_MS])
  manual.fire(BATCH_TIMEOUT_MS)
  assert.deepEqual(await pending, { ok: false, reason: 'claude gave no answer within 180 s' })
  const [pid] = await pids()
  await eventually(() => !alive(pid!), 'the claude process gone')
})

test('THE RUN’S SIGNAL ABORTED MID-BATCH: the claude group dies and the batch fails (criterion 20)', async () => {
  const run = new AbortController()
  const { input, pids } = await rig(['hang'], { signal: run.signal })
  const pending = classifyBatch(input)
  await eventually(async () => (await pids()).length === 1, 'claude started')
  run.abort()
  assert.deepEqual(await pending, { ok: false, reason: 'stopped' })
  const [pid] = await pids()
  await eventually(() => !alive(pid!), 'the claude process gone')
})

test('a signal already aborted never spawns', async () => {
  const run = new AbortController()
  run.abort()
  const { input, pids } = await rig(['ok'], { signal: run.signal })
  assert.deepEqual(await classifyBatch(input), { ok: false, reason: 'stopped' })
  assert.deepEqual(await pids(), [])
})

test('a binary that is not there, or a spawn that throws, is a failure and not an exception', async () => {
  const { input } = await rig()
  const missing = await classifyBatch({ ...input, bin: '/nonexistent/claude' })
  assert.equal(missing.ok, false)
  assert.match(missing.ok ? '' : missing.reason, /claude could not start: .*ENOENT/)
  const nul = await classifyBatch({ ...input, model: 'hai\u0000ku' })
  assert.equal(nul.ok, false)
  assert.match(nul.ok ? '' : nul.reason, /claude could not start/)
})

test('a non-zero exit is a failure with its code', async () => {
  const { input } = await rig()
  const result = await classifyBatch({ ...input, bin: '/usr/bin/false' })
  assert.deepEqual(result, { ok: false, reason: 'claude exited with code 1' })
})

test('a CLI that refuses its arguments: the first line of its stderr is the reason', async () => {
  const { input } = await rig(['refuse'])
  assert.deepEqual(await classifyBatch(input), {
    ok: false,
    reason: 'claude exited with code 1: Error: --json-schema is not a valid JSON Schema: no schema with key or ref',
  })
})

test('a claude that ignores SIGTERM gets SIGKILL after the grace, and the batch still settles', async () => {
  const manual = manualTimers()
  const { input, pids } = await rig(['stubborn'], { timers: manual.timers })
  const pending = classifyBatch(input)
  await eventually(async () => (await pids()).length === 1, 'claude started')
  const [pid] = await pids()
  // Let it install its SIGTERM trap before the deadline is forced.
  await new Promise((resolve) => setTimeout(resolve, 300))
  manual.fire(BATCH_TIMEOUT_MS)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(alive(pid!), true, 'SIGTERM alone did not end it')
  assert.deepEqual(manual.pending(), [KILL_GRACE_MS])
  manual.fire(KILL_GRACE_MS)
  assert.deepEqual(await pending, { ok: false, reason: 'claude gave no answer within 180 s' })
  await eventually(() => !alive(pid!), 'the stubborn claude is gone')
})
