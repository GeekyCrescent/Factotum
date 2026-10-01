/**
 * Questions through the real engine (spec 2026-10-01-preguntas-con-opciones): the MCP member, the
 * held call, how a batch ends and IN WHAT ORDER the log says so.
 *
 * Its own file, like `engine-subagents.test.ts`. The fake CLI never calls the tool itself: the test
 * plays the CLI's MCP client against `engine.mcp` while the fake keeps the session running.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NotificationMessage, Notifier, Timers } from '@factotum/core'
import { createEngine, type EngineDeps } from './engine.ts'
import { HOOK_TIMEOUT_SECONDS } from './permissions/settings.ts'
import { SiteLocks } from './locks.ts'
import { sessionPaths } from './paths.ts'
import {
  CANCELLED_TEXT,
  EXPIRED_TEXT,
  NOT_RUNNING,
  QUALIFIED_TOOL,
  SHUTDOWN_TEXT,
  UNREACHABLE,
  type ToolResult,
} from './questions/mcp.ts'
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
  readonly notices: NotificationMessage[]
}

async function world(options: { reachable?: boolean; deps?: EngineDeps } = {}): Promise<World> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'factotum-q-engine-')))
  const stateDir = join(home, 'state')
  const siteDir = join(home, 'site')
  await mkdir(stateDir, { recursive: true })
  await mkdir(siteDir, { recursive: true })
  const notices: NotificationMessage[] = []
  const notify: Notifier = { canReach: () => options.reachable !== false, send: async (m) => void notices.push(m) }
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
    { bin: FAKE, ...options.deps },
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
async function until(what: string, check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function turnOver(locks: SiteLocks): Promise<void> {
  await until('the site came back', async () => (await locks.heldBy('work')) === undefined, 15_000)
}

/** A running session that has gone quiet: what the questions write is what comes next. */
async function quietSession(engine: SessionEngine): Promise<string> {
  const id = await launch(engine, 'linger')
  await until('linger went quiet', async () => (await page(engine, id)).events.some((e) => e.kind === 'message' && e.role === 'assistant'))
  return id
}

const twoQuestions = {
  questions: [
    { text: 'Which colour?', options: [{ label: 'red' }, { label: 'green' }] },
    { text: 'Which sizes?', multiple: true, options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }] },
  ],
}

let rpcId = 0
function ask(engine: SessionEngine, sessionId: string, args: unknown, toolUseId?: string): Promise<McpReply> {
  rpcId += 1
  return engine.mcp(sessionId, {
    jsonrpc: '2.0',
    id: rpcId,
    method: 'tools/call',
    params: { name: 'ask_owner', arguments: args, ...(toolUseId === undefined ? {} : { _meta: { 'claudecode/toolUseId': toolUseId } }) },
  })
}

function toolResult(reply: McpReply): ToolResult {
  assert.equal(reply.kind, 'body')
  const body = (reply as { body: { result?: ToolResult } }).body
  assert.notEqual(body.result, undefined, JSON.stringify(body))
  return body.result as ToolResult
}

async function questionsEvents(engine: SessionEngine, id: string) {
  return (await page(engine, id)).events.filter((e) => e.kind === 'questions')
}

async function asked(engine: SessionEngine, id: string, notices: NotificationMessage[], count = 1) {
  await until('the batch was asked', async () => (await questionsEvents(engine, id)).filter((e) => e.kind === 'questions' && e.phase === 'asked').length >= count, 5_000)
  await until('the notice went out', () => notices.filter((n) => n.data?.['kind'] === 'questions').length >= count, 5_000)
  const notice = notices.filter((n) => n.data?.['kind'] === 'questions')[count - 1] as NotificationMessage
  return { notice, token: notice.data?.['questionsId'] as string, batch: notice.data?.['batch'] as string }
}

const kinds = (events: readonly SessionEvent[]) =>
  events
    .filter((e) => e.kind === 'questions' || (e.kind === 'state' && e.state !== 'running'))
    .map((e) => (e.kind === 'questions' ? `${e.phase}${e.phase === 'settled' ? `:${e.outcome}` : ''}` : `state:${e.kind === 'state' ? e.state : ''}`))

// ---------------------------------------------------------------------------
// Refusals that open nothing (criteria 6, 8, 9)
// ---------------------------------------------------------------------------

test('a call for a session that is not running, or for an id that is not one, opens nothing (criterion 8)', async () => {
  const { engine, notices } = await world()
  for (const id of ['not-a-session-id', '019a0000-0000-7000-8000-000000000000']) {
    const result = toolResult(await ask(engine, id, twoQuestions))
    assert.equal(result.isError, true)
    assert.equal(result.content[0]?.text, NOT_RUNNING)
  }
  assert.equal(notices.length, 0)
})

test('initialize and tools/list answer for any id: only tools/call looks at the session', async () => {
  const { engine } = await world()
  const init = await engine.mcp('not-a-session-id', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(init.kind, 'body')
  assert.equal(((init as { body: { result: { serverInfo: { name: string } } } }).body.result.serverInfo.name), 'factotum')
  assert.deepEqual(await engine.mcp('x', { jsonrpc: '2.0', method: 'notifications/initialized' }), { kind: 'accepted' })
})

test('without push the call comes back AT ONCE with UNREACHABLE, and nothing is asked or written (criterion 9)', async () => {
  const { engine, notices } = await world({ reachable: false })
  const id = await quietSession(engine)
  const result = toolResult(await ask(engine, id, twoQuestions))
  assert.equal(result.isError, true)
  assert.equal(result.content[0]?.text, UNREACHABLE)
  assert.deepEqual(await questionsEvents(engine, id), [])
  assert.equal(notices.filter((n) => n.data?.['kind'] === 'questions').length, 0)
  await engine.cancel(id)
})

test('a batch that cannot be fixed without inventing comes back as isError and opens nothing (criterion 6)', async () => {
  const { engine, notices } = await world()
  const id = await quietSession(engine)
  for (const args of [{ questions: [] }, { questions: [{ text: 'One?', options: [{ label: 'only' }] }] }, {}]) {
    const result = toolResult(await ask(engine, id, args))
    assert.equal(result.isError, true, JSON.stringify(args))
    assert.notEqual(result.content[0]?.text, '')
  }
  assert.deepEqual(await questionsEvents(engine, id), [])
  assert.equal(notices.filter((n) => n.data?.['kind'] === 'questions').length, 0)
  await engine.cancel(id)
})

// ---------------------------------------------------------------------------
// Asked, answered, and what each side sees (criteria 4, 11, 12, 13, 14, 15, 27)
// ---------------------------------------------------------------------------

test('the --mcp-config file is on disk after launching, with the session in its URL (criterion 4)', async () => {
  const { engine, stateDir } = await world()
  const id = await quietSession(engine)
  const config = JSON.parse(await readFile(sessionPaths(stateDir).mcpConfigFile(id), 'utf8'))
  assert.deepEqual(config, {
    mcpServers: {
      factotum: {
        type: 'http',
        url: `http://127.0.0.1:7778/modules/sessions/mcp/${id}`,
        timeout: HOOK_TIMEOUT_SECONDS * 1000,
        alwaysLoad: true,
      },
    },
  })
  await engine.cancel(id)
})

test('asked → notice → answered with gaps: the agent gets labels and unanswered, the log gets ids (criteria 11, 12)', async () => {
  const { engine, notices } = await world()
  const id = await quietSession(engine)
  const four = {
    questions: [
      { text: 'Which colour?', options: [{ label: 'red' }, { label: 'green' }] },
      { text: 'Which sizes?', multiple: true, options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }] },
      { text: 'A name?', options: [{ label: 'Ada' }, { label: 'Bob' }] },
      { text: 'Deploy?', options: [{ label: 'yes' }, { label: 'no' }] },
    ],
  }
  const held = ask(engine, id, four)
  const { notice, token, batch } = await asked(engine, id, notices)

  // The notice: the session and how many, NEVER the question (guardrail 5); a tag per batch.
  assert.equal(notice.title, 'questions')
  assert.equal(notice.body, 'work · 4 questions')
  assert.equal(notice.body.includes('colour'), false)
  assert.equal(notice.tag, `questions:${id}:${batch}`)
  assert.equal(notice.path, `/m/sessions/${id}?questions=${token}&batch=${batch}`)
  assert.equal(notice.data?.['count'], 4)
  assert.equal(notice.data?.['sessionId'], id)
  assert.equal(notice.data?.['siteId'], 'work')
  assert.equal(typeof notice.until, 'string')

  const answer = await engine.answerQuestions(token, {
    answers: [
      { question: 'q2', kind: 'chosen', options: ['o1', 'o3'] },
      { question: 'q1', kind: 'chosen', options: ['o2'] },
    ],
  })
  assert.deepEqual(answer, { kind: 'answered', first: true })

  const result = toolResult(await held)
  assert.equal(result.isError, undefined)
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ''), {
    answers: [
      { question: 'Which colour?', chosen: ['green'] },
      { question: 'Which sizes?', chosen: ['S', 'L'] },
      { question: 'A name?', unanswered: true },
      { question: 'Deploy?', unanswered: true },
    ],
  })

  await until('settled', async () => (await questionsEvents(engine, id)).length === 2)
  const [opened, closed] = await questionsEvents(engine, id)
  assert.equal(opened?.kind === 'questions' && opened.phase === 'asked' ? opened.questions.length : 0, 4)
  assert.equal(opened?.kind === 'questions' ? opened.id : '', batch)
  assert.equal(closed?.kind === 'questions' ? closed.id : '', batch)
  assert.deepEqual(closed?.kind === 'questions' && closed.phase === 'settled' ? closed.answers : [], [
    { question: 'q1', kind: 'chosen', options: ['o2'] },
    { question: 'q2', kind: 'chosen', options: ['o1', 'o3'] },
    { question: 'q3', kind: 'none' },
    { question: 'q4', kind: 'none' },
  ])
  assert.equal('task' in (opened as object), false)
  await engine.cancel(id)
})

test('inspect by token: the batch while pending, how it ended after (design D5)', async () => {
  const { engine, notices } = await world()
  const id = await quietSession(engine)
  const held = ask(engine, id, twoQuestions)
  const { token, batch } = await asked(engine, id, notices)

  const pending = await engine.inspectQuestions(token)
  assert.equal(pending.kind, 'pending')
  if (pending.kind === 'pending') {
    assert.equal(pending.sessionId, id)
    assert.equal(pending.siteId, 'work')
    assert.equal(pending.id, batch)
    assert.equal(pending.questions.length, 2)
    assert.equal(pending.task, undefined)
  }
  assert.deepEqual(await engine.inspectQuestions('nope'), { kind: 'unknown' })

  await engine.answerQuestions(token, { answers: [] })
  await held
  assert.deepEqual(await engine.inspectQuestions(token), { kind: 'over', how: 'answered' })
  await engine.cancel(id)
})

test('an answer that does not fit its batch is invalid and resolves nothing (criteria 13, 14)', async () => {
  const { engine, notices } = await world()
  const id = await quietSession(engine)
  const held = ask(engine, id, twoQuestions)
  const { token } = await asked(engine, id, notices)

  const bad = [
    { answers: [{ question: 'q1', kind: 'chosen', options: ['o1', 'o2'] }] }, // two on a single
    { answers: [{ question: 'q1', kind: 'chosen', options: ['zz'] }] }, // not its option
    { answers: [{ question: 'q9', kind: 'none' }] }, // not its question
    { answers: [{ question: 'q1', kind: 'text', text: '   ' }] }, // empty text
    'nonsense',
  ]
  for (const body of bad) {
    const answer = await engine.answerQuestions(token, body)
    assert.equal(answer.kind, 'invalid', JSON.stringify(body))
  }
  assert.equal((await engine.inspectQuestions(token)).kind, 'pending')

  // Two on a multiple is exactly those two.
  assert.deepEqual(await engine.answerQuestions(token, { answers: [{ question: 'q2', kind: 'chosen', options: ['o1', 'o2'] }] }), {
    kind: 'answered',
    first: true,
  })
  const result = JSON.parse(toolResult(await held).content[0]?.text ?? '')
  assert.deepEqual(result.answers[1], { question: 'Which sizes?', chosen: ['S', 'M'] })
  await engine.cancel(id)
})

test('answering twice is first: true then first: false, and the agent gets only the first (criterion 15)', async () => {
  const { engine, notices } = await world()
  const id = await quietSession(engine)
  const held = ask(engine, id, twoQuestions)
  const { token } = await asked(engine, id, notices)
  assert.deepEqual(await engine.answerQuestions(token, { answers: [{ question: 'q1', kind: 'chosen', options: ['o1'] }] }), { kind: 'answered', first: true })
  assert.deepEqual(await engine.answerQuestions(token, { answers: [{ question: 'q1', kind: 'chosen', options: ['o2'] }] }), { kind: 'answered', first: false })
  const result = JSON.parse(toolResult(await held).content[0]?.text ?? '')
  assert.deepEqual(result.answers[0], { question: 'Which colour?', chosen: ['red'] })
  assert.deepEqual(await engine.answerQuestions('unknown-token', { answers: [] }), { kind: 'unknown' })
  await engine.cancel(id)
})

test('the token is in no file of the session after an answered batch (criterion 27)', async () => {
  const { engine, notices, stateDir } = await world()
  const id = await quietSession(engine)
  const held = ask(engine, id, twoQuestions)
  const { token } = await asked(engine, id, notices)
  await engine.answerQuestions(token, { answers: [] })
  await held
  await until('settled', async () => (await questionsEvents(engine, id)).length === 2)
  const dir = sessionPaths(stateDir).sessionDir(id)
  const files = await readdir(dir)
  assert.equal(files.includes('mcp.json'), true)
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8')
    assert.equal(text.includes(token), false, file)
  }
  await engine.cancel(id)
})

// ---------------------------------------------------------------------------
// Expiring, cancelling, stopping — and the order in the log (criteria 16, 21, 22, 42)
// ---------------------------------------------------------------------------

test('a batch nobody answers expires: the agent is told to end its turn, the session is NOT cancelled (criteria 16, 17)', async () => {
  const { engine, notices } = await world({ deps: { askTimeoutMs: 150 } })
  const id = await quietSession(engine)
  const held = ask(engine, id, twoQuestions)
  const { token } = await asked(engine, id, notices)
  const result = toolResult(await held)
  assert.equal(result.isError, true)
  assert.equal(result.content[0]?.text, EXPIRED_TEXT)
  await until('settled', async () => (await questionsEvents(engine, id)).length === 2)
  assert.deepEqual(kinds((await page(engine, id)).events), ['asked', 'settled:expired'])
  assert.equal((await page(engine, id)).state, 'running')
  assert.deepEqual(await engine.answerQuestions(token, { answers: [] }), { kind: 'over', how: 'expired' })
  await engine.cancel(id)
})

test('Cancel releases the batch BEFORE it returns; one settled, before the cancelled state; then 409 cancelled (criterion 21)', async () => {
  const { engine, notices } = await world()
  const id = await quietSession(engine)
  let released = false
  const held = ask(engine, id, twoQuestions).then((reply) => {
    released = true
    return reply
  })
  const { token } = await asked(engine, id, notices)

  await engine.cancel(id)
  assert.equal(released, true, 'the held call resolved before cancel returned')
  assert.equal(toolResult(await held).content[0]?.text, CANCELLED_TEXT)
  assert.deepEqual(kinds((await page(engine, id)).events), ['asked', 'settled:cancelled', 'state:cancelled'])
  assert.deepEqual(await engine.answerQuestions(token, { answers: [] }), { kind: 'over', how: 'cancelled' })
})

test('stop() settles every batch as shutdown BEFORE its session’s cancelled state (criterion 22)', async () => {
  const { engine, notices } = await world()
  const id = await quietSession(engine)
  const held = ask(engine, id, twoQuestions)
  await asked(engine, id, notices)
  await engine.stop()
  assert.equal(toolResult(await held).content[0]?.text, SHUTDOWN_TEXT)
  await until('both written', async () => kinds((await page(engine, id)).events).length === 3)
  assert.deepEqual(kinds((await page(engine, id)).events), ['asked', 'settled:shutdown', 'state:cancelled'])
})

test('a process that exits by itself with a batch open: settled cancelled before the terminal state, and its askers are gone (criterion 42)', async () => {
  const { engine, notices, siteDir, locks } = await world()
  const id = await launch(engine, 'ask-then-exit')
  // The gate notes a subagent's call that never reaches the tool: finalize must forget it.
  await engine.decide({
    hook_event_name: 'PreToolUse',
    session_id: id,
    tool_name: QUALIFIED_TOOL,
    tool_input: twoQuestions,
    tool_use_id: 'toolu_orphan',
    cwd: siteDir,
    agent_id: 'a-orphan',
  })
  const held = ask(engine, id, twoQuestions, 'toolu_main')
  const { token } = await asked(engine, id, notices)
  await turnOver(locks)

  assert.equal(toolResult(await held).content[0]?.text, CANCELLED_TEXT)
  const order = kinds((await page(engine, id)).events)
  assert.deepEqual(order, ['asked', 'settled:cancelled', 'state:finished'])
  assert.deepEqual(await engine.answerQuestions(token, { answers: [] }), { kind: 'over', how: 'cancelled' })

  // The same session, resumed: the orphan's tool_use_id no longer names a subagent.
  const again = await engine.reply(id, 'linger')
  assert.equal(again.outcome, 'started')
  const second = ask(engine, id, twoQuestions, 'toolu_orphan')
  await asked(engine, id, notices, 2)
  const latest = (await questionsEvents(engine, id)).filter((e) => e.kind === 'questions' && e.phase === 'asked').at(-1)
  assert.equal('task' in (latest as object), false)
  await engine.cancel(id)
  await second
})

// ---------------------------------------------------------------------------
// Who asked (criterion 23)
// ---------------------------------------------------------------------------

test('the gate notes the subagent by tool_use_id; its batch carries the task, the main agent’s has no key (criterion 23)', async () => {
  const { engine, notices, siteDir } = await world()
  const id = await quietSession(engine)

  const verdict = await engine.decide({
    hook_event_name: 'PreToolUse',
    session_id: id,
    tool_name: QUALIFIED_TOOL,
    tool_input: twoQuestions,
    tool_use_id: 'toolu_sub',
    cwd: siteDir,
    agent_id: 'a1b2c3',
    agent_type: 'general-purpose',
  })
  // The gate does not change its decision for it (guardrail 6) and writes nothing.
  assert.equal(verdict.hookSpecificOutput.permissionDecision, 'allow')
  assert.deepEqual(await questionsEvents(engine, id), [])

  const fromSub = ask(engine, id, twoQuestions, 'toolu_sub')
  const first = await asked(engine, id, notices)
  const fromMain = ask(engine, id, twoQuestions, 'toolu_main')
  const second = await asked(engine, id, notices, 2)

  const asks = (await questionsEvents(engine, id)).filter((e) => e.kind === 'questions' && e.phase === 'asked')
  assert.equal(asks[0]?.kind === 'questions' ? asks[0].task : '', 'a1b2c3')
  assert.equal('task' in (asks[1] as object), false)
  assert.equal((await engine.inspectQuestions(first.token)).kind === 'pending', true)
  const inspected = await engine.inspectQuestions(first.token)
  assert.equal(inspected.kind === 'pending' ? inspected.task : '', 'a1b2c3')
  assert.notEqual(first.notice.tag, second.notice.tag)

  await engine.answerQuestions(first.token, { answers: [] })
  await fromSub
  await until('settled', async () => (await questionsEvents(engine, id)).filter((e) => e.kind === 'questions' && e.phase === 'settled').length === 1)
  const settled = (await questionsEvents(engine, id)).find((e) => e.kind === 'questions' && e.phase === 'settled')
  assert.equal(settled?.kind === 'questions' ? settled.task : '', 'a1b2c3')
  await engine.cancel(id)
  await fromMain
})
