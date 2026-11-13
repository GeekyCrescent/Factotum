import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import * as repo from '../store/repo.ts'
import { NOW, valueOf } from '../test-state.ts'
import { eventually, PROCESS_GONE_MS, realTimers, tempBase } from '../test-support.ts'
import type { JobHandler } from './queue.ts'
import { runClaude } from './run.ts'
import { DONE, queueStore, rig, workOf } from './test-queue.ts'

const FAKE = fileURLToPath(new URL('../../test/fixtures/fake-claude.mjs', import.meta.url))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('criterion 27: stop() kills the hung runs and waits; the next start puts them back in the queue and runs them', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const cwd = await mkdtemp(join(tmpdir(), 'factotum-jobs-stop-'))
  await chmod(FAKE, 0o755)
  await writeFile(join(cwd, 'fake-claude.modes'), 'hang\n')
  const pids = async (): Promise<number[]> => {
    try {
      return (await readFile(join(cwd, 'fake-claude.calls'), 'utf8')).trim().split('\n').map(Number)
    } catch {
      return []
    }
  }
  const claude: JobHandler = async (work, ctx) => {
    const run = await runClaude({ prompt: work.ref, jsonSchema: '{}', output: z.object({ title: z.string() }), model: 'sonnet', effort: undefined, cwd, timers: realTimers, now: () => NOW, signal: ctx.signal, timeoutMs: ctx.timeoutMs, bin: FAKE })
    return run.ok ? DONE : run
  }
  // Concurrency 3: two bulk at once (D10 keeps the third slot for interactive).
  const { queue } = rig(db, { concurrency: 3, handlers: { cv: claude } })
  const ids = ['a1', 'a2', 'a3'].map((ref) => valueOf(queue.add({ kind: 'cv', ref })).id)
  await eventually(async () => (await pids()).length === 2, 'two claudes started')

  await queue.stop()
  for (const pid of await pids()) await eventually(() => !alive(pid), `claude ${pid} gone`, PROCESS_GONE_MS)
  assert.deepEqual(queue.running(), [])
  // A stopped run writes nothing: no attempt, no failure; the row stays as the process left it.
  assert.deepEqual(ids.map((id) => [workOf(db, id).state, workOf(db, id).attempts]), [['running', 0], ['running', 0], ['queued', 0]])
  assert.equal(queue.add({ kind: 'cv', ref: 'a4' }).ok, false, 'a stopped queue takes nothing more')
  queue.pump()
  assert.equal((await pids()).length, 2, 'and starts nothing')

  // The next start: the opening write turns running back into queued (D10 «Al arrancar»).
  const recovered = valueOf(db.tx((q) => ({ ok: true, value: repo.recoverOnStart(q, NOW) })))
  assert.equal(recovered.work, 2)
  assert.deepEqual(ids.map((id) => workOf(db, id).state), ['queued', 'queued', 'queued'])
  const next = rig(db, { handlers: { cv: async () => DONE } })
  next.queue.pump()
  await next.queue.settled()
  assert.deepEqual(ids.map((id) => workOf(db, id).state), ['done', 'done', 'done'])
})

test('stop() with nothing running resolves at once, and twice is harmless', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const { queue } = rig(db)
  await queue.stop()
  await queue.stop()
  assert.deepEqual(queue.running(), [])
})
