import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { runAgent } from './run.ts'
import type { EventInput } from './types.ts'

const run = promisify(execFile)
const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'fake-claude.mjs')

function collector(): { events: EventInput[]; onEvent: (e: EventInput) => Promise<void> } {
  const events: EventInput[] = []
  return { events, onEvent: async (event) => void events.push(event) }
}

/**
 * The fake stands exactly where the real binary would: `bin` is the only seam, and it
 * exists because the alternative is a test that spends quota to prove that a pipe was
 * read. It is the same shape as the kernel's own `makeServer` seam.
 */
function startWithScript(prompt: string, onEvent: (e: EventInput) => Promise<void>) {
  return runAgent({
    sessionId: 'sid-1',
    invoke: { kind: 'none' },
    input: prompt,
    settingsPath: FAKE,
    resume: false,
    cwd: tmpdir(),
    onEvent,
    bin: FAKE,
  })
}

// ---------------------------------------------------------------------------
// The happy path, over a real subprocess
// ---------------------------------------------------------------------------

test('a run translates the stream into events, in arrival order, and then exits', async () => {
  const { events, onEvent } = collector()
  const agent = startWithScript('quick', onEvent)
  const exit = await agent.done

  assert.equal(exit.code, 0)
  assert.deepEqual(events.map((e) => e.kind), ['tool', 'result', 'message', 'state'])
})

test('the events are PERSISTED before the run is called over', async () => {
  // The chain is what makes this true: `done` waits for the last write.
  const order: string[] = []
  const agent = startWithScript('quick', async (event) => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    order.push(event.kind)
  })
  await agent.done
  assert.deepEqual(order, ['tool', 'result', 'message', 'state'])
})

test('lines that are not JSON are ignored instead of ending the session', async () => {
  const { events, onEvent } = collector()
  const exit = await startWithScript('noise', onEvent).done
  assert.equal(exit.code, 0)
  assert.equal(events.some((e) => e.kind === 'state'), true)
})

test('a non-zero exit carries its stderr, clipped', async () => {
  const { onEvent } = collector()
  const exit = await startWithScript('boom', onEvent).done
  assert.equal(exit.code, 3)
  assert.match(exit.stderr, /something went wrong/)
})

test('a binary that does not exist resolves instead of taking the daemon down', async () => {
  // Without the `error` listener registered first, this is an unhandled 'error' event
  // and the whole process dies.
  const { onEvent } = collector()
  const agent = runAgent({
    sessionId: 'sid-1',
    invoke: { kind: 'none' },
    input: 'x',
    settingsPath: '/dev/null',
    resume: false,
    cwd: tmpdir(),
    onEvent,
    bin: '/definitely/not/a/binary',
  })
  const exit = await agent.done
  assert.equal(exit.code, null)
  assert.match(exit.stderr, /ENOENT|not a binary/)
})

test('a write that throws does not lose the run, it surfaces in the exit', async () => {
  const agent = startWithScript('quick', async () => {
    throw new Error('the disk is full')
  })
  const exit = await agent.done
  assert.match(exit.stderr, /the disk is full/)
})

// ---------------------------------------------------------------------------
// Criterion 18 — killing the GROUP, not the child
// ---------------------------------------------------------------------------

test('cancelling kills the whole process group, grandchildren included', async () => {
  const { onEvent } = collector()
  const agent = startWithScript('linger', onEvent)
  assert.notEqual(agent.pid, undefined)

  // Wait until the grandchild exists, rather than guessing a delay.
  const pid = agent.pid ?? 0
  const descendants = async (): Promise<string[]> => {
    try {
      const { stdout } = await run('ps', ['-o', 'pid=,pgid=', '-A'])
      return stdout
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts[1] === String(pid))
        .map((parts) => parts[0] ?? '')
    } catch {
      return []
    }
  }

  const deadline = Date.now() + 10_000
  while ((await descendants()).length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal((await descendants()).length >= 2, true, 'the fake should have a grandchild by now')

  agent.kill()
  await agent.done

  // And nothing in that group is left. This is what `ps` checks at criterion 18.
  const after = Date.now() + 10_000
  let left = await descendants()
  while (left.length > 0 && Date.now() < after) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    left = await descendants()
  }
  assert.deepEqual(left, [])
})


test('killing a run that already finished is not an error', async () => {
  const { onEvent } = collector()
  const agent = startWithScript('quick', onEvent)
  await agent.done
  assert.doesNotThrow(() => agent.kill())
})

test('killing a run that never spawned is not an error', async () => {
  const { onEvent } = collector()
  const agent = runAgent({
    sessionId: 'sid-1',
    invoke: { kind: 'none' },
    input: 'x',
    settingsPath: '/dev/null',
    resume: false,
    cwd: tmpdir(),
    onEvent,
    bin: '/definitely/not/a/binary',
  })
  await agent.done
  assert.doesNotThrow(() => agent.kill())
})
