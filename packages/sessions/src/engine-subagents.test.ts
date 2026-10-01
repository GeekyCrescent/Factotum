/**
 * Subagents through the real engine (spec 2026-10-01-subagentes-visibles): a background subagent's
 * two `result`s, a Cancel with a subagent open, and what the GATE writes for a subagent's tool.
 *
 * Its own file, like `uploads/engine-uploads.test.ts`, rather than more of `engine.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NotificationMessage, Notifier, Timers } from '@factotum/core'
import { createEngine } from './engine.ts'
import { SiteLocks } from './locks.ts'
import { sessionPaths } from './paths.ts'
import { memoryRegistry } from './test-registry.ts'
import type { EventPage, SessionEngine, SessionEvent, TitlesConfig } from './types.ts'

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
  readonly notices: NotificationMessage[]
}

async function world(options: { reachable?: boolean } = {}): Promise<World> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'factotum-sub-engine-')))
  const stateDir = join(home, 'state')
  const siteDir = join(home, 'site')
  await mkdir(stateDir, { recursive: true })
  await mkdir(siteDir, { recursive: true })
  const notices: NotificationMessage[] = []
  const notify: Notifier = { canReach: () => options.reachable === true, send: async (m) => void notices.push(m) }
  const engine = await createEngine(
    {
      titles: TITLES_OFF,
      uploadMaxBytes: 20 * 1024 * 1024,
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
    { bin: FAKE },
  )
  return { engine, stateDir, siteDir, locks: new SiteLocks(sessionPaths(stateDir)), notices }
}

async function page(engine: SessionEngine, id: string): Promise<EventPage> {
  const result = await engine.read(id, 0)
  assert.equal('kind' in result, false, `read ${id} was refused: ${JSON.stringify(result)}`)
  return result as EventPage
}

async function launch(engine: SessionEngine, text: string): Promise<string> {
  const result = await engine.launch({ siteId: 'work', entryId: 'free', text, force: false })
  assert.equal(result.outcome, 'started')
  return result.outcome === 'started' ? result.sessionId : ''
}

/** Poll, do not guess (CLAUDE.md §7). */
async function until(what: string, check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function turnOver(locks: SiteLocks): Promise<void> {
  await until('the site came back', async () => (await locks.heldBy('work')) === undefined, 15_000)
}

const terminal = (e: SessionEvent) => e.kind === 'state' && e.state !== 'running'

// ---------------------------------------------------------------------------
// The stream through the engine
// ---------------------------------------------------------------------------

test('GUARD: a background subagent and its two results end the session ONCE, finished (criterion 12)', async () => {
  // Passes before this spec too: finalize writes the only terminal state (requirements §0.3).
  const { engine, locks } = await world()
  const id = await launch(engine, 'subagent-bg')
  await turnOver(locks)
  const events = (await page(engine, id)).events
  assert.deepEqual(
    events.filter(terminal).map((e) => (e.kind === 'state' ? e.state : '')),
    ['finished'],
  )
})

test('a Cancel with a subagent open leaves its start, no end, and the cancelled state (criterion 36)', async () => {
  const { engine, locks } = await world()
  const id = await launch(engine, 'subagent-kill')
  await until('the subagent started', async () => (await page(engine, id)).events.some((e) => e.kind === 'subagent'), 5_000)

  await engine.cancel(id)
  await turnOver(locks)

  const events = (await page(engine, id)).events
  const subagent = events.filter((e) => e.kind === 'subagent')
  assert.deepEqual(
    subagent.map((e) => (e.kind === 'subagent' ? e.phase : '')),
    ['started'],
  )
  assert.equal(events.filter(terminal).at(-1)?.kind === 'state' ? (events.filter(terminal).at(-1) as { state: string }).state : '', 'cancelled')
})

// ---------------------------------------------------------------------------
// The gate (design D9)
// ---------------------------------------------------------------------------

/** A running session that has gone quiet, so what the gate writes is the last thing in the log. */
async function quietSession(engine: SessionEngine): Promise<string> {
  const id = await launch(engine, 'linger')
  await until('linger went quiet', async () => (await page(engine, id)).events.some((e) => e.kind === 'message' && e.role === 'assistant'))
  return id
}

function payload(sessionId: string, cwd: string, extra: Record<string, unknown> = {}, input: Record<string, unknown> = { file_path: '/etc/outside.txt' }) {
  return { hook_event_name: 'PreToolUse', session_id: sessionId, tool_name: 'Write', tool_input: input, tool_use_id: 'toolu_1', cwd, ...extra }
}

async function lastResult(engine: SessionEngine, id: string) {
  const results = (await page(engine, id)).events.filter((e) => e.kind === 'result')
  return results.at(-1)
}

async function rawLog(stateDir: string, id: string): Promise<string> {
  return readFile(sessionPaths(stateDir).eventsFile(id), 'utf8')
}

test("a DENY for a subagent's tool carries its task, and its reason already names the path; the main agent's is exactly as before (criteria 33, 37)", async () => {
  const { engine, siteDir, stateDir } = await world()
  const id = await quietSession(engine)

  const mine = await engine.decide(payload(id, siteDir))
  assert.equal(mine.hookSpecificOutput.permissionDecision, 'deny')
  const main = await lastResult(engine, id)
  assert.equal(main?.kind === 'result' ? main.task : 'x', undefined)
  assert.match(main?.kind === 'result' ? main.summary : '', /^denied: writes outside work: \/etc\/outside\.txt$/)
  assert.equal((await rawLog(stateDir, id)).includes('"task"'), false, 'no task key at all for the main agent')

  const theirs = await engine.decide(payload(id, siteDir, { agent_id: 'a1b2c3', agent_type: 'general-purpose' }))
  assert.equal(theirs.hookSpecificOutput.permissionDecision, 'deny')
  const sub = await lastResult(engine, id)
  assert.equal(sub?.kind === 'result' ? sub.task : '', 'a1b2c3')
  // The reason names the path already: it is not said twice.
  assert.equal(sub?.kind === 'result' ? sub.summary : '', main?.kind === 'result' ? main.summary : 'x')
  assert.equal(theirs.hookSpecificOutput.permissionDecisionReason, mine.hookSpecificOutput.permissionDecisionReason)

  await engine.cancel(id)
})

test("an OWNER'S ANSWER for a subagent's tool carries its task and the path (criteria 33, 37)", async () => {
  const { engine, siteDir, notices } = await world({ reachable: true })
  const id = await quietSession(engine)

  const pending = engine.decide(payload(id, siteDir, { agent_id: 'a1b2c3' }))
  await until('the ask went out', async () => notices.some((n) => typeof n.data?.['askId'] === 'string'), 5_000)
  const askId = notices.find((n) => typeof n.data?.['askId'] === 'string')?.data?.['askId'] as string
  await engine.answer(askId, 'allow')
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'allow')

  const sub = await lastResult(engine, id)
  assert.equal(sub?.kind === 'result' ? sub.task : '', 'a1b2c3')
  assert.equal(sub?.kind === 'result' ? sub.summary : '', '/etc/outside.txt: approved by the owner')
  assert.equal(sub?.kind === 'result' ? sub.ok : false, true)

  await engine.cancel(id)
})

test("a subagent's write with no path is allowed and writes nothing, exactly as the main agent's (criterion 37)", async () => {
  const { engine, siteDir } = await world()
  const id = await quietSession(engine)
  const before = (await page(engine, id)).events.length
  const answer = await engine.decide(payload(id, siteDir, { agent_id: 'a1b2c3' }, { content: 'x' }))
  assert.equal(answer.hookSpecificOutput.permissionDecision, 'allow')
  assert.equal((await page(engine, id)).events.length, before)
  await engine.cancel(id)
})

test('GUARD: a malformed agent_id neither breaks the payload nor turns an allow into a deny (criterion 32)', async () => {
  const { engine, siteDir } = await world()
  const id = await quietSession(engine)
  const answer = await engine.decide(payload(id, siteDir, { agent_id: 7 }, { file_path: join(siteDir, 'a.txt') }))
  assert.equal(answer.hookSpecificOutput.permissionDecision, 'allow')
  await engine.cancel(id)
})
