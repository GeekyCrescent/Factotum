/**
 * Background services through the real engine (spec 2026-10-02-servicios-en-segundo-plano, tasks D5): the MCP
 * member, the life of a service across turns, and IN WHAT ORDER the log says how it ended.
 *
 * Like `engine-questions.test.ts`, the fake CLI never calls the tool: the test plays the CLI's MCP client
 * against `engine.mcp` while the fake keeps the turn running. The services are REAL processes, under
 * `/bin/sh -c` (the `serviceSeams` of the engine): a group, a trap and a death are what is being tested.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Notifier, Timers } from '@factotum/core'
import { createEngine, type EngineDeps } from './engine.ts'
import { SiteLocks } from './locks.ts'
import { sessionPaths } from './paths.ts'
import { NOT_RUNNING, type ToolResult } from './questions/mcp.ts'
import type { ServiceRegistry } from './services/registry.ts'
import { RESTART_REASON } from './services/shape.ts'
import { groupExists } from './services/spawn.ts'
import { memoryRegistry } from './test-registry.ts'
import type { EventPage, McpReply, SessionEngine, SessionEvent, TitlesConfig } from './types.ts'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'fake-claude.mjs')
const TITLES_OFF: TitlesConfig = { enabled: false, model: 'haiku', effort: 'low' }

const timers: Timers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms)
    handle.unref()
    return { [Symbol.dispose]: () => clearInterval(handle) }
  },
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref()
    return { [Symbol.dispose]: () => clearTimeout(handle) }
  },
}

interface World {
  readonly engine: SessionEngine
  readonly stateDir: string
  readonly siteDir: string
  readonly locks: SiteLocks
}

async function engineOn(stateDir: string, siteDir: string, deps: EngineDeps = {}): Promise<SessionEngine> {
  const notify: Notifier = { canReach: () => true, send: async () => undefined }
  return await createEngine(
    {
      titles: TITLES_OFF,
      stateDir,
      registry: memoryRegistry({ sites: [{ id: 'work', path: siteDir }] }),
      home: '/nonexistent-home-for-tests',
      factotumRoot: '/nonexistent-home-for-tests/.factotum',
      installRoot: undefined,
      catalog: [{ id: 'free', label: 'Free prompt', invoke: { kind: 'none' } }],
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => new Date(),
      timers,
      hookUrl: () => 'http://127.0.0.1:7778',
      notify,
    },
    { bin: FAKE, ...deps, serviceSeams: { shell: ['/bin/sh', '-c'], ...deps.serviceSeams } },
  )
}

async function world(deps: EngineDeps = {}): Promise<World> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'factotum-s-engine-')))
  const stateDir = join(home, 'state')
  const siteDir = join(home, 'site')
  await mkdir(stateDir, { recursive: true })
  await mkdir(siteDir, { recursive: true })
  return { engine: await engineOn(stateDir, siteDir, deps), stateDir, siteDir, locks: new SiteLocks(sessionPaths(stateDir)) }
}

async function page(engine: SessionEngine, id: string): Promise<EventPage> {
  const result = await engine.read(id, 0)
  assert.equal('kind' in result, false, `read ${id} was refused: ${JSON.stringify(result)}`)
  return result as EventPage
}

async function launch(engine: SessionEngine, text: string): Promise<string> {
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text, force: false })
  assert.equal(result.outcome, 'started', JSON.stringify(result))
  return result.outcome === 'started' ? result.sessionId : ''
}

async function until(what: string, check: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function turnOver(locks: SiteLocks): Promise<void> {
  await until('the site came back', async () => (await locks.heldBy('work')) === undefined)
}

let rpcId = 0
function call(engine: SessionEngine, sessionId: string, name: string, args: unknown): Promise<McpReply> {
  rpcId += 1
  return engine.mcp(sessionId, { jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args } })
}

function toolResult(reply: McpReply): ToolResult {
  assert.equal(reply.kind, 'body')
  return (reply as { body: { result: ToolResult } }).body.result
}

async function startService(engine: SessionEngine, sessionId: string, command: string): Promise<{ id: string; pid: number }> {
  const result = toolResult(await call(engine, sessionId, 'start_service', { command }))
  assert.equal(result.isError, undefined, result.content[0]?.text)
  const text = result.content[0]?.text ?? ''
  const match = /service (s\d+) \(pid (\d+)\)/.exec(text)
  assert.ok(match, text)
  return { id: match[1] as string, pid: Number(match[2]) }
}

const serviceKinds = (events: readonly SessionEvent[]) =>
  events
    .filter((e) => e.kind === 'service' || (e.kind === 'state' && e.state !== 'running'))
    .map((e) => (e.kind === 'service' ? `${e.phase}${e.phase === 'ended' ? `:${e.outcome}` : ''}` : `state:${e.kind === 'state' ? e.state : ''}`))

async function gone(pid: number): Promise<void> {
  await until(`group ${pid} to be gone`, () => !groupExists(pid))
}

// ---------------------------------------------------------------------------
// It outlives the turn (criteria 16, 23, 39, 40)
// ---------------------------------------------------------------------------

test('the service outlives the turn and a reply; a new session on the same site starts (criteria 16, 23)', async () => {
  const { engine, locks } = await world()
  const id = await launch(engine, 'service-then-exit')
  const service = await startService(engine, id, 'echo up; sleep 600')
  await turnOver(locks)
  assert.equal((await page(engine, id)).state, 'finished')
  assert.equal(groupExists(service.pid), true, 'alive after the turn')

  // The owner reads it from the route, the turn long over.
  const read = await engine.readService(id, service.id, 50)
  assert.equal(read?.view.state, 'running')
  assert.deepEqual(read?.lines, ['up'])

  // A reply in the same session and a new session in the same project: no 409 (criterion 23).
  assert.equal((await engine.reply(id, 'quick')).outcome, 'started')
  await turnOver(locks)
  const other = await launch(engine, 'quick')
  await turnOver(locks)
  assert.notEqual(other, id)
  assert.equal(groupExists(service.pid), true, 'alive after the reply')

  // With no turn running, the agent's tools answer NOT_RUNNING (criterion 40); the owner's route does not care.
  assert.equal(toolResult(await call(engine, id, 'list_services', {})).content[0]?.text, NOT_RUNNING)
  const stopped = await engine.stopService(id, service.id)
  assert.equal(stopped?.state, 'stopped')
  assert.equal(stopped?.by, 'owner')
  await gone(service.pid)
  await engine.stop()
})

// ---------------------------------------------------------------------------
// Cancel (criterion 21)
// ---------------------------------------------------------------------------

test('Cancel stops a service that ignores SIGTERM: its ended is in the log BEFORE cancelled, and no process is left', async () => {
  const { engine } = await world()
  const id = await launch(engine, 'linger')
  const service = await startService(engine, id, "trap '' TERM; sleep 600")
  await engine.cancel(id)
  assert.deepEqual(serviceKinds((await page(engine, id)).events), ['started', 'ended:cancelled', 'state:cancelled'])
  assert.equal(groupExists(service.pid), false, 'cancel waited for the death')
  await engine.stop()
})

// ---------------------------------------------------------------------------
// Deleting (criterion 22)
// ---------------------------------------------------------------------------

test('deleting a finished conversation stops its service first: no process and no files left', async () => {
  const { engine, locks, stateDir } = await world()
  const id = await launch(engine, 'service-then-exit')
  const service = await startService(engine, id, 'echo out; sleep 600')
  await turnOver(locks)
  assert.deepEqual(await engine.remove([id]), [{ id, outcome: 'removed' }])
  assert.equal(groupExists(service.pid), false)
  await assert.rejects(stat(sessionPaths(stateDir).sessionDir(id)))
  await engine.stop()
})

test('deleting a LIVE conversation answers running and leaves its service alone', async () => {
  const { engine } = await world()
  const id = await launch(engine, 'linger')
  const service = await startService(engine, id, 'sleep 600')
  assert.deepEqual(await engine.remove([id]), [{ id, outcome: 'running' }])
  assert.equal(groupExists(service.pid), true)
  await engine.cancel(id)
  await gone(service.pid)
  await engine.stop()
})

// ---------------------------------------------------------------------------
// stop() and the next start (criteria 24, 25, 44)
// ---------------------------------------------------------------------------

test('stop(): shutdown in the log, the registry kept; the next engine kills what survived and empties it', async () => {
  const { engine, stateDir, siteDir } = await world()
  const id = await launch(engine, 'linger')
  const service = await startService(engine, id, "trap '' TERM; sleep 600")
  const before = Date.now()
  await engine.stop()
  assert.ok(Date.now() - before < 1_000, `stop() took ${Date.now() - before} ms (criterion 44)`)
  assert.deepEqual(serviceKinds((await page(engine, id)).events), ['started', 'ended:shutdown', 'state:cancelled'])
  const registry = sessionPaths(stateDir).servicesRegistry
  assert.equal(JSON.parse(await readFile(registry, 'utf8')).services.length, 1)
  assert.equal(groupExists(service.pid), true, 'it ignored SIGTERM and no rescue was armed')

  const next = await engineOn(stateDir, siteDir)
  await next.reconcile()
  await gone(service.pid)
  assert.equal(JSON.parse(await readFile(registry, 'utf8')).services.length, 0)
  // Its ended was already there: reconcile writes no second one (criterion 32).
  assert.deepEqual(serviceKinds((await page(next, id)).events).filter((k) => k.startsWith('ended')), ['ended:shutdown'])
  // And it is still readable (criterion 39).
  assert.equal((await next.readService(id, service.id, 10))?.view.state, 'shutdown')
  await next.stop()
})

test('a service whose daemon died without stop() is closed by the next start as stopped by restart (criterion 25)', async () => {
  const { engine, locks, stateDir, siteDir } = await world()
  const id = await launch(engine, 'quick')
  await turnOver(locks)
  await engine.stop()
  // What a kill -9 of the daemon leaves on disk: a live group, its `started`, and a registry whose daemon is
  // gone (2^22 is above macOS's pid ceiling, so no process has it).
  const child = spawn('/bin/sh', ['-c', 'sleep 600'], { detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  const pid = child.pid as number
  const paths = sessionPaths(stateDir)
  await appendFile(paths.eventsFile(id), `${JSON.stringify({ seq: 100, at: 't', kind: 'service', phase: 'started', id: 's1', command: 'sleep 600', cwd: siteDir, maxMinutes: 480, pid })}\n`)
  await writeFile(paths.servicesRegistry, JSON.stringify({ daemonPid: 4_194_304, services: [{ sessionId: id, id: 's1', pid, startedAt: 't' }] }))

  const next = await engineOn(stateDir, siteDir)
  await next.reconcile()
  await gone(pid)
  const ended = (await page(next, id)).events.find((e) => e.kind === 'service' && e.phase === 'ended')
  assert.equal(ended?.kind === 'service' && ended.phase === 'ended' ? [ended.outcome, ended.reason].join(':') : '', `shutdown:${RESTART_REASON}`)
  assert.equal((await next.readService(id, 's1', 10))?.view.state, 'shutdown')
  await next.stop()
})

// ---------------------------------------------------------------------------
// Cancel in the middle of a start (criterion 43)
// ---------------------------------------------------------------------------

test('Cancel while start_service waits on the registry: started → ended → cancelled, and no process', async () => {
  let entered!: () => void
  const inside = new Promise<void>((resolve) => (entered = resolve))
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const wrapRegistry = (real: ServiceRegistry): ServiceRegistry => ({
    ...real,
    add: async (entry) => {
      entered()
      await held
      await real.add(entry)
    },
  })
  const { engine } = await world({ serviceSeams: { wrapRegistry } })
  const id = await launch(engine, 'linger')
  const reply = call(engine, id, 'start_service', { command: "trap '' TERM; sleep 600" })
  await inside
  const cancelling = engine.cancel(id)
  await new Promise((resolve) => setTimeout(resolve, 100))
  release()
  await cancelling
  assert.deepEqual(serviceKinds((await page(engine, id)).events), ['started', 'ended:cancelled', 'state:cancelled'])
  const result = toolResult(await reply)
  assert.equal(result.isError, true)
  const pid = Number(/"pid":(\d+)/.exec(JSON.stringify((await page(engine, id)).events))?.[1] ?? 0)
  assert.ok(pid > 0)
  assert.equal(groupExists(pid), false)
  await engine.stop()
})

test('the gate redirects a background Bash and writes NOTHING to the log (criteria 12, 13)', async () => {
  const { engine } = await world()
  const id = await launch(engine, 'linger')
  const decision = await engine.decide({
    session_id: id,
    tool_name: 'Bash',
    tool_input: { command: 'python3 -m http.server 8765', run_in_background: true },
    tool_use_id: 'tu1',
    cwd: '/tmp',
    hook_event_name: 'PreToolUse',
  })
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /mcp__factotum__start_service/)
  assert.equal((await page(engine, id)).events.some((e) => e.kind === 'result'), false)
  await engine.cancel(id)
  await engine.stop()
})
