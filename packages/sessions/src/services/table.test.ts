/**
 * The table with a FAKE spawn, a fake clock and a fake registry (tasks B6). What a process really does with
 * a signal is `spawn.test.ts`'s; here every exit, every chunk and every timer is the test's to fire, so the
 * ORDER of the writes — which is what criteria 21, 32 and 43 are about — can be asserted exactly.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger, Timers } from '@factotum/core'
import { sessionPaths } from '../paths.ts'
import type { EventInput, SessionEvent } from '../types.ts'
import type { RegistryEntry, ServiceRegistry } from './registry.ts'
import { DEFAULT_MAX_MINUTES, MAX_LOGGED_COMMAND_CHARS, STARTUP_GRACE_MS, type StartRequest } from './shape.ts'
import type { ServiceExit, SpawnInput, SpawnedService } from './spawn.ts'
import { createServiceTable, type ServiceTable, type StartOutcome } from './table.ts'

// --- the fakes ------------------------------------------------------------------

interface Deferred<T = void> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface FakeProcess {
  readonly input: SpawnInput
  readonly pid: number
  readonly kills: boolean[]
  readonly exit: (exit: ServiceExit) => void
  readonly say: (text: string) => void
  readonly drain: () => void
}

interface ManualTimer {
  readonly ms: number
  readonly fn: () => void
  disposed: boolean
}

interface World {
  readonly table: ServiceTable
  readonly logs: Map<string, SessionEvent[]>
  readonly processes: FakeProcess[]
  readonly timers: ManualTimer[]
  readonly registry: RegistryEntry[]
  readonly warnings: string[]
  readonly reads: { count: number }
  /** Set to hold the next `events` read / `stat` / `registry.add` until released. */
  readonly holds: { events?: Deferred; stat?: Deferred; add?: Deferred; addFails?: boolean }
  readonly root: string
  readonly fire: (ms: number) => void
  readonly log: (sessionId: string) => readonly SessionEvent[]
}

const SESSION = 'sess-a'
const OTHER = 'sess-b'

async function world(seed: Record<string, SessionEvent[]> = {}, shared?: { logs: Map<string, SessionEvent[]>; root: string }): Promise<World> {
  const root = shared?.root ?? (await mkdtemp(join(tmpdir(), 'factotum-table-')))
  const logs = shared?.logs ?? new Map<string, SessionEvent[]>(Object.entries(seed))
  const processes: FakeProcess[] = []
  const timers: ManualTimer[] = []
  const registry: RegistryEntry[] = []
  const warnings: string[] = []
  const reads = { count: 0 }
  const holds: World['holds'] = {}
  let pids = 5000

  const append = (sessionId: string, event: EventInput): Promise<unknown> => {
    // SYNCHRONOUS like the store's queue: the order of the calls IS the order of the log.
    const log = logs.get(sessionId) ?? []
    const full = { ...event, seq: log.length, at: `t${log.length}` } as SessionEvent
    logs.set(sessionId, [...log, full])
    return Promise.resolve(full)
  }

  const fakeTimers: Timers = {
    setInterval: () => ({ [Symbol.dispose]: () => undefined }),
    setTimeout: (fn, ms) => {
      const timer: ManualTimer = { ms, fn, disposed: false }
      timers.push(timer)
      return { [Symbol.dispose]: () => void (timer.disposed = true) }
    },
  }

  const spawn = (input: SpawnInput): SpawnedService => {
    const done = deferred<ServiceExit>()
    const drained = deferred()
    const kills: boolean[] = []
    pids += 1
    const proc: FakeProcess = {
      input,
      pid: pids,
      kills,
      exit: (exit) => done.resolve(exit),
      say: (text) => input.onOutput(Buffer.from(text)),
      drain: () => drained.resolve(),
    }
    processes.push(proc)
    return { pid: pids, done: done.promise, drained: drained.promise, kill: (graceful) => void kills.push(graceful) }
  }

  const fakeRegistry: ServiceRegistry = {
    daemonPid: 1,
    read: async () => ({ kind: 'ok', daemonPid: 1, services: registry }),
    add: async (entry) => {
      await holds.add?.promise
      if (holds.addFails === true) throw new Error('disk full')
      registry.push(entry)
    },
    remove: async (sessionId, id) => {
      const at = registry.findIndex((e) => e.sessionId === sessionId && e.id === id)
      if (at !== -1) registry.splice(at, 1)
    },
    clear: async () => void registry.splice(0),
    quarantine: async () => undefined,
  }

  const table = createServiceTable({
    append,
    events: async (sessionId) => {
      reads.count += 1
      await holds.events?.promise
      return logs.get(sessionId) ?? []
    },
    registry: fakeRegistry,
    paths: sessionPaths(root),
    shell: ['/bin/sh', '-c'],
    timers: fakeTimers,
    now: () => new Date('2026-10-02T12:00:00.000Z'),
    log: { info: () => undefined, warn: (m: string) => void warnings.push(m), error: () => undefined } as Logger,
    spawn,
    isDirectory: async () => {
      await holds.stat?.promise
      return true
    },
  })

  return {
    table,
    logs,
    processes,
    timers,
    registry,
    warnings,
    reads,
    holds,
    root,
    fire: (ms) => {
      for (const timer of timers.filter((t) => t.ms === ms && !t.disposed)) {
        timer.disposed = true
        timer.fn()
      }
    },
    log: (sessionId) => logs.get(sessionId) ?? [],
  }
}

const request = (command = 'python3 -m http.server 8765', extra: Partial<StartRequest> = {}): StartRequest => ({
  command,
  description: undefined,
  cwd: '/work',
  maxMinutes: DEFAULT_MAX_MINUTES,
  ...extra,
})

/** Every fake process exits and drains, so every output file is closed before the directory goes. */
async function close(w: World): Promise<void> {
  for (const p of w.processes) {
    p.exit({ code: null, signal: 'SIGTERM' })
    p.drain()
  }
  for (let i = 0; i < 20; i += 1) await tick()
  await rm(w.root, { recursive: true, force: true })
}

const tick = async (): Promise<void> => await new Promise((resolve) => setImmediate(resolve))

/** Starts a service and lets it through the startup grace. */
async function startLive(w: World, sessionId = SESSION, req = request()): Promise<Started> {
  const pending = w.table.start(sessionId, req, undefined)
  await until(() => w.timers.some((t) => t.ms === STARTUP_GRACE_MS && !t.disposed))
  w.fire(STARTUP_GRACE_MS)
  return asStarted(await pending)
}

type Started = Extract<StartOutcome, { kind: 'started' }>

function asStarted(outcome: StartOutcome): Started {
  if (outcome.kind !== 'started') throw new Error(`expected started, got ${outcome.kind}`)
  return outcome
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await tick()
  if (!check()) throw new Error('condition never held')
}

const kinds = (log: readonly SessionEvent[]): string[] =>
  log.map((e) => (e.kind === 'service' ? `${e.phase}:${e.id}${e.phase === 'ended' ? `:${e.outcome}` : ''}` : e.kind))

// --- starting --------------------------------------------------------------------

test('a start writes `started` with the clipped command and answers with the id and pid after the grace', async () => {
  const w = await world()
  const long = `echo ${'x'.repeat(MAX_LOGGED_COMMAND_CHARS * 2)}`
  const outcome = await startLive(w, SESSION, request(long, { description: 'web', maxMinutes: 30 }))
  assert.equal(outcome.kind, 'started')
  assert.equal(outcome.view.id, 's1')
  assert.equal(outcome.view.pid, w.processes[0]?.pid)
  assert.equal(outcome.view.state, 'running')
  // The FULL command runs; the log keeps it clipped.
  assert.equal(w.processes[0]?.input.command, long)
  const [started] = w.log(SESSION)
  assert.equal(started?.kind === 'service' && started.phase === 'started' && started.command.startsWith('echo xxx'), true)
  assert.ok(started?.kind === 'service' && started.phase === 'started' && started.command.length < long.length)
  assert.deepEqual(w.registry, [{ sessionId: SESSION, id: 's1', pid: w.processes[0]?.pid, startedAt: '2026-10-02T12:00:00.000Z' }])
  await close(w)
})

test('ids continue from the log: s<max+1>, read once per session (criterion 39)', async () => {
  const seed = [
    { seq: 0, at: 't', kind: 'service', phase: 'started', id: 's1', command: 'a', cwd: '/w', maxMinutes: 1, pid: 9 },
    { seq: 1, at: 't', kind: 'service', phase: 'started', id: 's3', command: 'b', cwd: '/w', maxMinutes: 1, pid: 9 },
  ] as SessionEvent[]
  const w = await world({ [SESSION]: seed })
  assert.equal((await startLive(w)).view.id, 's4')
  assert.equal((await startLive(w)).view.id, 's5')
  assert.equal(w.reads.count, 1)
  await close(w)
})

test('TWO CONCURRENT starts get s1 and s2 from ONE read of the log, and both are in the registry (criterion 43)', async () => {
  const w = await world()
  const both = Promise.all([w.table.start(SESSION, request('a'), undefined), w.table.start(SESSION, request('b'), undefined)])
  await until(() => w.timers.filter((t) => t.ms === STARTUP_GRACE_MS).length === 2)
  w.fire(STARTUP_GRACE_MS)
  const [a, b] = (await both).map(asStarted)
  assert.deepEqual([a?.view.id, b?.view.id].sort(), ['s1', 's2'])
  assert.equal(w.reads.count, 1)
  assert.equal(w.registry.length, 2)
  await close(w)
})

test('a command that exits during the grace comes back exited-early WITH its last line (criterion 6)', async () => {
  const w = await world()
  const pending = w.table.start(SESSION, request('python3 -m http.server 80'), undefined)
  await until(() => w.processes.length === 1)
  const proc = w.processes[0] as FakeProcess
  proc.exit({ code: 1, signal: null })
  // `exit` before the last `data`: only `drained` guarantees it is in (D3).
  await tick()
  proc.say('OSError: [Errno 48] Address already in use\n')
  proc.drain()
  const outcome = await pending
  if (outcome.kind !== 'exited-early') throw new Error(`expected exited-early, got ${outcome.kind}`)
  assert.equal(outcome.view.state, 'failed')
  assert.equal(outcome.view.code, 1)
  assert.deepEqual(outcome.lines, ['OSError: [Errno 48] Address already in use'])
  assert.deepEqual(kinds(w.log(SESSION)), ['started:s1', 'ended:s1:failed'])
  await close(w)
})

test('a cwd that is not a directory is refused and nothing is written or launched (criterion 7)', async () => {
  const w = await world()
  const refused = await createWithStat(w, false).start(SESSION, request(), undefined)
  assert.equal(refused.kind, 'refused')
  assert.match(refused.kind === 'refused' ? refused.reason : '', /\/work/)
  assert.deepEqual([w.processes.length, w.log(SESSION).length], [0, 0])
  await close(w)
})

/** A second table over the same world whose `isDirectory` answers `answer`. */
function createWithStat(w: World, answer: boolean): ServiceTable {
  return createServiceTable({
    append: async () => undefined,
    events: async () => [],
    registry: { daemonPid: 1, read: async () => ({ kind: 'empty' }), add: async () => undefined, remove: async () => undefined, clear: async () => undefined, quarantine: async () => undefined },
    paths: sessionPaths(w.root),
    shell: ['/bin/sh', '-c'],
    timers: { setInterval: () => ({ [Symbol.dispose]: () => undefined }), setTimeout: () => ({ [Symbol.dispose]: () => undefined }) },
    now: () => new Date(0),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined } as Logger,
    spawn: () => {
      throw new Error('must not launch')
    },
    isDirectory: async () => answer,
  })
}

// --- how it ends -------------------------------------------------------------------

test('the default timer is 8 h; an explicit one fires as timeout, with a graceful kill (criterion 19)', async () => {
  const w = await world()
  await startLive(w)
  assert.ok(w.timers.some((t) => t.ms === DEFAULT_MAX_MINUTES * 60_000))
  await startLive(w, SESSION, request('x', { maxMinutes: 1 }))
  w.fire(60_000)
  assert.deepEqual(w.processes[1]?.kills, [true])
  assert.deepEqual(kinds(w.log(SESSION)), ['started:s1', 'started:s2', 'ended:s2:timeout'])
  await close(w)
})

test('exit 0 is exited; another code is failed with it; a signal nobody sent is failed with it (criterion 20)', async () => {
  const w = await world()
  for (let i = 0; i < 3; i += 1) await startLive(w)
  w.processes[0]?.exit({ code: 0, signal: null })
  w.processes[1]?.exit({ code: 2, signal: null })
  w.processes[2]?.exit({ code: null, signal: 'SIGSEGV' })
  await until(() => w.log(SESSION).length === 6)
  const ends = w.log(SESSION).filter((e) => e.kind === 'service' && e.phase === 'ended')
  assert.deepEqual(
    ends.map((e) => (e.kind === 'service' && e.phase === 'ended' ? [e.id, e.outcome, e.code, e.signal] : [])),
    [
      ['s1', 'exited', 0, undefined],
      ['s2', 'failed', 2, undefined],
      ['s3', 'failed', undefined, 'SIGSEGV'],
    ],
  )
  await close(w)
})

test('two simultaneous stops write ONE ended; stop then a natural exit, still one (criterion 32)', async () => {
  const w = await world()
  await startLive(w)
  await startLive(w)
  const [a, b] = await Promise.all([w.table.stop(SESSION, 's1', 'owner'), w.table.stop(SESSION, 's1', 'agent')])
  assert.equal(a?.state, 'stopped')
  assert.equal(b?.by, 'owner')
  await w.table.stop(SESSION, 's2', 'agent')
  w.processes[1]?.exit({ code: 143, signal: null })
  w.processes[0]?.exit({ code: null, signal: 'SIGTERM' })
  await tick()
  assert.deepEqual(kinds(w.log(SESSION)), ['started:s1', 'started:s2', 'ended:s1:stopped', 'ended:s2:stopped'])
  await close(w)
})

test('stopSession QUEUES every ended in the same tick, before anything dies, and waits for the deaths (criterion 21)', async () => {
  const w = await world()
  await startLive(w)
  await startLive(w)
  const stopping = w.table.stopSession(SESSION, 'cancelled')
  // Synchronously: no await between the call and these assertions.
  assert.deepEqual(kinds(w.log(SESSION)), ['started:s1', 'started:s2', 'ended:s1:cancelled', 'ended:s2:cancelled'])
  assert.deepEqual(
    w.processes.map((p) => p.kills),
    [[true], [true]],
  )
  let resolved = false
  void stopping.then(() => (resolved = true))
  await tick()
  assert.equal(resolved, false, 'it waits for the deaths')
  for (const p of w.processes) {
    p.exit({ code: null, signal: 'SIGKILL' })
    p.drain()
  }
  await stopping
  assert.deepEqual(w.registry, [])
  await close(w)
})

test('stopAll: SIGTERM with no rescue, ended as shutdown, resolves WITHOUT the deaths and keeps the registry (criteria 24, 44)', async () => {
  const w = await world()
  await startLive(w)
  await startLive(w, OTHER)
  const armedBefore = w.timers.length
  await w.table.stopAll('the daemon was shutting down')
  assert.equal(w.timers.length, armedBefore, 'no timer armed')
  assert.deepEqual(
    w.processes.map((p) => p.kills),
    [[false], [false]],
  )
  assert.deepEqual(kinds(w.log(SESSION)), ['started:s1', 'ended:s1:shutdown'])
  assert.deepEqual(kinds(w.log(OTHER)), ['started:s1', 'ended:s1:shutdown'])
  for (const p of w.processes) {
    p.exit({ code: null, signal: 'SIGTERM' })
    p.drain()
  }
  await tick()
  await tick()
  assert.equal(w.registry.length, 2, 'the next start reconciles what survived')
  // After stopAll, start refuses without launching.
  const after = await w.table.start(SESSION, request(), undefined)
  assert.equal(after.kind, 'refused')
  assert.equal(w.processes.length, 2)
  await close(w)
})

// --- reading what ended (criterion 39) ----------------------------------------------

test('read, stop and list answer an ended service, also from a NEW table over the same log; another session is "none"', async () => {
  const w = await world()
  await startLive(w)
  w.processes[0]?.say('GET / 200\n')
  w.processes[0]?.exit({ code: 0, signal: null })
  w.processes[0]?.drain()
  await until(() => w.log(SESSION).length === 2)
  await until(() => w.registry.length === 0)

  const read = await w.table.read(SESSION, 's1', 50)
  assert.equal(read?.view.state, 'exited')
  assert.deepEqual(read?.lines, ['GET / 200'])
  assert.equal((await w.table.stop(SESSION, 's1', 'agent'))?.state, 'exited')
  assert.equal(w.log(SESSION).length, 2, 'stopping an ended service writes nothing')

  // "Restart": a fresh table, nothing in memory.
  const again = await world({}, { logs: w.logs, root: w.root })
  assert.equal((await again.table.read(SESSION, 's1', 50))?.lines[0], 'GET / 200')
  assert.deepEqual(
    (await again.table.list(SESSION)).map((v) => [v.id, v.state]),
    [['s1', 'exited']],
  )
  assert.equal(await again.table.read(OTHER, 's1', 50), undefined)
  assert.equal(await again.table.stop(OTHER, 's1', 'agent'), undefined)
  assert.equal(await again.table.read(SESSION, 's9', 50), undefined)
  await close(w)
})

test('list shows the live ones from memory over what the log says', async () => {
  const w = await world()
  await startLive(w)
  await startLive(w)
  await w.table.stop(SESSION, 's2', 'owner')
  assert.deepEqual(
    (await w.table.list(SESSION)).map((v) => [v.id, v.state]),
    [
      ['s1', 'running'],
      ['s2', 'stopped'],
    ],
  )
  await close(w)
})

// --- atomicity (criterion 43) ----------------------------------------------------------

for (const which of ['events', 'stat'] as const) {
  test(`stopSession while start holds the ${which === 'events' ? 'log read' : 'cwd check'}: discarded, nothing written, nothing launched`, async () => {
    const w = await world()
    w.holds[which] = deferred()
    const pending = w.table.start(SESSION, request(), undefined)
    await tick()
    const stopping = w.table.stopSession(SESSION, 'cancelled')
    w.holds[which]?.resolve()
    const outcome = await pending
    await stopping
    assert.equal(outcome.kind, 'refused')
    assert.deepEqual([w.processes.length, w.log(SESSION).length, w.registry.length], [0, 0, 0])
    await close(w)
  })
}

test('after stopSession, start is refused until reopen', async () => {
  const w = await world()
  await w.table.stopSession(SESSION, 'cancelled')
  assert.equal((await w.table.start(SESSION, request(), undefined)).kind, 'refused')
  // Another session is not closing.
  assert.equal((await startLive(w, OTHER)).kind, 'started')
  w.table.reopen(SESSION)
  assert.equal((await startLive(w)).kind, 'started')
  await close(w)
})

test('pending of a session with no entries resolves at once, WITHOUT reading the log', async () => {
  const w = await world()
  await w.table.pending(SESSION)
  assert.equal(w.reads.count, 0)
  await close(w)
})

test('stopSession while start waits on the registry: started BEFORE ended, and pending covers both', async () => {
  const w = await world()
  w.holds.add = deferred()
  const pending = w.table.start(SESSION, request(), undefined)
  await until(() => w.processes.length === 1)
  const stopping = w.table.stopSession(SESSION, 'cancelled')
  let covered = false
  const waited = w.table.pending(SESSION).then(() => (covered = true))
  await tick()
  assert.equal(covered, false)
  w.holds.add.resolve()
  await waited
  assert.deepEqual(kinds(w.log(SESSION)), ['started:s1', 'ended:s1:cancelled'])
  assert.deepEqual(w.processes[0]?.kills, [true])
  w.processes[0]?.exit({ code: null, signal: 'SIGTERM' })
  w.processes[0]?.drain()
  await stopping
  // Stopped before the agent heard back: never answered as started.
  const outcome = await pending
  assert.equal(outcome.kind, 'refused')
  assert.match(outcome.kind === 'refused' ? outcome.reason : '', /stopped while it was starting/)
  await close(w)
})

test('stopAll with a start half way waits for its started and ended, then refuses new ones', async () => {
  const w = await world()
  w.holds.add = deferred()
  const pending = w.table.start(SESSION, request(), undefined)
  await until(() => w.processes.length === 1)
  let done = false
  const stopping = w.table.stopAll('the daemon was shutting down').then(() => (done = true))
  await tick()
  assert.equal(done, false)
  w.holds.add.resolve()
  await stopping
  assert.deepEqual(kinds(w.log(SESSION)), ['started:s1', 'ended:s1:shutdown'])
  assert.deepEqual(w.processes[0]?.kills, [false])
  w.fire(STARTUP_GRACE_MS)
  w.processes[0]?.exit({ code: null, signal: 'SIGTERM' })
  await pending
  await close(w)
})

test('the registry fails with the process launched: group killed, started + ended failed, refused', async () => {
  const w = await world()
  w.holds.addFails = true
  const outcome = await w.table.start(SESSION, request(), undefined)
  assert.equal(outcome.kind, 'refused')
  assert.deepEqual(w.processes[0]?.kills, [true])
  const log = w.log(SESSION)
  assert.deepEqual(kinds(log), ['started:s1', 'ended:s1:failed'])
  const ended = log[1]
  assert.equal(ended?.kind === 'service' && ended.phase === 'ended' ? ended.reason : '', 'could not record the service')
  await close(w)
})

test('a spawn that throws writes nothing and is refused', async () => {
  const w = await world()
  const table = createServiceTable({
    append: async (s, e) => void w.logs.set(s, [...w.log(s), e as SessionEvent]),
    events: async () => [],
    registry: { daemonPid: 1, read: async () => ({ kind: 'empty' }), add: async () => undefined, remove: async () => undefined, clear: async () => undefined, quarantine: async () => undefined },
    paths: sessionPaths(w.root),
    shell: ['/bin/sh', '-c'],
    timers: { setInterval: () => ({ [Symbol.dispose]: () => undefined }), setTimeout: () => ({ [Symbol.dispose]: () => undefined }) },
    now: () => new Date(0),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined } as Logger,
    spawn: () => {
      throw new Error('ENOENT')
    },
    isDirectory: async () => true,
  })
  const outcome = await table.start(SESSION, request(), undefined)
  assert.equal(outcome.kind, 'refused')
  assert.equal(w.log(SESSION).length, 0)
  await close(w)
})

test('a subagent that starts a service is written as its task (criterion 15)', async () => {
  const w = await world()
  const pending = w.table.start(SESSION, request(), 'agent-7')
  await until(() => w.timers.some((t) => t.ms === STARTUP_GRACE_MS))
  w.fire(STARTUP_GRACE_MS)
  assert.equal(asStarted(await pending).view.task, 'agent-7')
  const [started] = w.log(SESSION)
  assert.equal(started?.kind === 'service' && started.phase === 'started' ? started.task : '', 'agent-7')
  await close(w)
})

test('stopAll and pending do not wait on a start stuck BEFORE its id (a hung cwd check)', async () => {
  const w = await world()
  w.holds.stat = deferred()
  const pending = w.table.start(SESSION, request(), undefined)
  await tick()
  let stopped = false
  const stopping = w.table.stopAll('the daemon was shutting down').then(() => (stopped = true))
  await tick()
  await tick()
  assert.equal(stopped, true, 'stopAll resolved with the cwd check still hung')
  await w.table.pending(SESSION)
  w.holds.stat.resolve()
  assert.equal((await pending).kind, 'refused')
  await stopping
  assert.deepEqual([w.processes.length, w.log(SESSION).length], [0, 0])
  await close(w)
})
