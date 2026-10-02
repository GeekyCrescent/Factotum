/**
 * Real processes, like `run.spawn.test.ts`: a group, a signal and a pipe are exactly the things a double
 * would get right by construction. The shell is `/bin/sh -c`, never the owner's login shell: a test does
 * not read `~/.zshrc` (CLAUDE.md §7, inject the world).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type { Timers } from '@factotum/core'
import { groupExists, spawnService, type SpawnedService } from './spawn.ts'

const run = promisify(execFile)
const SH = ['/bin/sh', '-c'] as const

/** Real timers, but the grace is short: a test does not wait KILL_GRACE_MS. */
const quick: Timers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms)
    return { [Symbol.dispose]: () => clearInterval(handle) }
  },
  setTimeout: (fn) => {
    const handle = setTimeout(fn, 200)
    return { [Symbol.dispose]: () => clearTimeout(handle) }
  },
}

function start(command: string, timers: Timers = quick): { service: SpawnedService; output: () => string } {
  const chunks: Buffer[] = []
  const service = spawnService({ command, cwd: tmpdir(), shell: SH, onOutput: (chunk) => void chunks.push(chunk), timers })
  return { service, output: () => Buffer.concat(chunks).toString('utf8') }
}

async function eventually(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function pgrep(pgid: number): Promise<string> {
  try {
    return (await run('pgrep', ['-g', String(pgid)])).stdout.trim()
  } catch {
    return ''
  }
}

test('the service leads a process group of its own', async () => {
  const { service } = start('sleep 30')
  const { stdout } = await run('ps', ['-o', 'pgid=', '-p', String(service.pid)])
  assert.equal(Number(stdout.trim()), service.pid)
  assert.equal(groupExists(service.pid), true)
  service.kill(false)
  await service.done
})

test('stdout and stderr both reach onOutput, in arrival order (criterion 28)', async () => {
  const { service, output } = start('echo one; sleep 0.1; echo two >&2; sleep 0.1; echo three')
  assert.deepEqual(await service.done, { code: 0, signal: null })
  await service.drained
  assert.equal(output(), 'one\ntwo\nthree\n')
})

test('killing kills the GROUP: a service with children leaves none alive (criterion 17)', async () => {
  const { service } = start('sleep 600 & sleep 600 & wait')
  await eventually(() => true, 'start')
  await new Promise((resolve) => setTimeout(resolve, 100))
  service.kill(true)
  const exit = await service.done
  assert.equal(exit.signal, 'SIGTERM')
  // AFTER `done`: before it the group is legitimately still there, and the test would be intermittent.
  await eventually(() => !groupExists(service.pid), 'the group to be gone')
  assert.equal(await pgrep(service.pid), '')
})

test('a leader that ignores SIGTERM is SIGKILLed after the grace (criterion 18)', async () => {
  const { service } = start("trap '' TERM; sleep 600")
  await new Promise((resolve) => setTimeout(resolve, 100))
  service.kill(true)
  const exit = await service.done
  assert.equal(exit.signal, 'SIGKILL')
  await eventually(() => !groupExists(service.pid), 'the group to be gone')
})

test('a CHILD that ignores SIGTERM dies too once its leader is gone (criterion 18)', async () => {
  // The leader dies of the SIGTERM; the subshell ignores it and would outlive it.
  const { service } = start("(trap '' TERM; sleep 600) & wait")
  await new Promise((resolve) => setTimeout(resolve, 100))
  service.kill(true)
  await service.done
  await eventually(() => !groupExists(service.pid), 'the trapping child to be gone')
  assert.equal(await pgrep(service.pid), '')
})

test('kill(false) sends SIGTERM only and arms no timer', async () => {
  let armed = 0
  const counting: Timers = { ...quick, setTimeout: (fn, ms) => ((armed += 1), quick.setTimeout(fn, ms)) }
  const { service } = start('sleep 600', counting)
  const before = armed
  service.kill(false)
  // Read at once: the exit arms the DRAIN timer later, which is not a rescue.
  assert.equal(armed, before)
  await service.done
})

test('done resolves on EXIT even when a grandchild holds the pipe, and the grandchild dies (risk 13)', async () => {
  const { service } = start('sleep 600 & exit 3')
  const started = Date.now()
  assert.deepEqual(await service.done, { code: 3, signal: null })
  assert.ok(Date.now() - started < 5_000)
  // A service IS its group: once the leader exits by itself, what is left is killed.
  await eventually(() => !groupExists(service.pid), 'the orphaned grandchild to be gone')
})

test('drained arrives with the last line of a command that just failed already delivered', async () => {
  const { service, output } = start('echo boom; exit 1')
  assert.deepEqual(await service.done, { code: 1, signal: null })
  await service.drained
  assert.equal(output(), 'boom\n')
})

test('a shell that does not exist throws to the caller and does NOT take the process down', async () => {
  assert.throws(() =>
    spawnService({ command: 'true', cwd: tmpdir(), shell: ['/nonexistent/factotum-sh', '-c'], onOutput: () => undefined, timers: quick }),
  )
  // The `error` event fires on a later tick; with no listener it would be an uncaught exception.
  await new Promise((resolve) => setTimeout(resolve, 100))
})

test('groupExists: ESRCH is false, EPERM is TRUE (a group of zombies), anything else is true', (t) => {
  const kill = t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('esrch'), { code: 'ESRCH' })
  })
  assert.equal(groupExists(12345), false)
  kill.mock.mockImplementation(() => {
    throw Object.assign(new Error('eperm'), { code: 'EPERM' })
  })
  assert.equal(groupExists(12345), true)
  kill.mock.mockImplementation(() => {
    throw new Error('something else')
  })
  assert.equal(groupExists(12345), true)
  kill.mock.mockImplementation(() => true as const)
  assert.equal(groupExists(12345), true)
  assert.deepEqual(kill.mock.calls.at(-1)?.arguments, [-12345, 0])
})

test('a rescue whose SIGKILL fails does not throw out of its timer', async (t) => {
  let rescue: (() => void) | undefined
  const held: Timers = { ...quick, setTimeout: (fn) => ((rescue ??= fn), { [Symbol.dispose]: () => undefined }) }
  const { service } = start('sleep 600', held)
  service.kill(true)
  await service.done
  // Now the group "exists" and every signal fails: the rescue must swallow it.
  t.mock.method(process, 'kill', (_pid: number, signal: unknown) => {
    if (signal === 0) return true
    throw Object.assign(new Error('einval'), { code: 'EINVAL' })
  })
  assert.ok(rescue !== undefined)
  assert.doesNotThrow(() => rescue?.())
})
