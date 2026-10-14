import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BOARD_FILE } from './board/store.ts'
import { createTasks } from './tasks.ts'
import { createTasksLink } from './link.ts'
import { board, captureLog, fakeTimers, NOW, silentNotify, task, ZONE } from './test-support.ts'
import type { Result, Tasks, TasksDeps } from './types.ts'

interface Harness {
  readonly tasks: Tasks
  readonly dir: string
  readonly clock: { now: Date }
  readonly log: ReturnType<typeof captureLog>
}

async function harness(t: { after: (fn: () => Promise<void>) => void }, config: unknown = { timeZone: ZONE }, seed?: string): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'tasks-facade-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  if (seed !== undefined) await writeFile(join(dir, BOARD_FILE), seed, { mode: 0o600 })
  const clock = { now: NOW }
  const log = captureLog()
  const deps: TasksDeps = { config, stateDir: dir, log, now: () => clock.now, timers: fakeTimers(), notify: silentNotify }
  const created = await createTasks(deps)
  if (!created.ok) throw new Error(`expected tasks, got: ${created.reason}`)
  return { tasks: created.tasks, dir, clock, log }
}

function ok<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.reason}`)
  return result.value
}

function errorOf<T>(result: Result<T>): { code: string; field?: string } {
  if (result.ok) throw new Error('expected an error')
  return result.error.code === 'invalid' ? { code: 'invalid', field: result.error.field } : { code: result.error.code }
}

test('a fresh board opens the current cycle and is empty', async (t) => {
  const { tasks } = await harness(t)
  const view = tasks.board()
  assert.equal(view.openCycle, '2026-W42')
  assert.equal(view.tasks.length, 0)
  assert.equal(view.needsClose, false)
})

test('create, then the card is on the board, by id, and on disk with a uuidv7 id', async (t) => {
  const { tasks, dir } = await harness(t)
  const card = ok(await tasks.create({ title: 'Essay', status: 'todo' }))
  assert.match(card.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/)
  assert.equal(tasks.get(card.id)?.title, 'Essay')
  assert.deepEqual(
    tasks.board().tasks.map((x) => x.id),
    [card.id],
  )
  assert.ok((await readFile(join(dir, BOARD_FILE), 'utf8')).includes(card.id))
})

test('a body over a limit is invalid with its field, and nothing is written (criterion 10)', async (t) => {
  const { tasks } = await harness(t)
  assert.deepEqual(errorOf(await tasks.create({ title: 'x'.repeat(201), status: 'todo' })), { code: 'invalid', field: 'title' })
  assert.deepEqual(errorOf(await tasks.patch('any', { labels: Array(11).fill('l') })), { code: 'invalid', field: 'labels' })
  assert.deepEqual(errorOf(await tasks.move('any', { status: 'nowhere' })), { code: 'invalid', field: 'status' })
  assert.deepEqual(errorOf(await tasks.accept('any', { to: 'done' })), { code: 'invalid', field: 'to' })
  assert.deepEqual(errorOf(await tasks.linkSession('any', { host: null, sessionId: 'x' })), { code: 'invalid', field: 'sessionId' })
  assert.deepEqual(errorOf(await tasks.closeCycles({ from: 'W42' })), { code: 'invalid', field: 'from' })
  assert.equal(tasks.board().tasks.length, 0)
})

test('patch, move and remove go through, and a missing card is not-found', async (t) => {
  const { tasks } = await harness(t)
  const card = ok(await tasks.create({ title: 'a', status: 'backlog' }))
  assert.equal(ok(await tasks.patch(card.id, { area: 'BWR' })).area, 'BWR')
  const moved = ok(await tasks.move(card.id, { status: 'done' }))
  assert.equal(moved.status, 'done')
  assert.equal(moved.completedAt, NOW.toISOString())
  assert.deepEqual(ok(await tasks.remove(card.id)), { id: card.id })
  assert.equal(tasks.get(card.id), undefined)
  assert.deepEqual(errorOf(await tasks.patch(card.id, {})), { code: 'not-found' })
  assert.deepEqual(errorOf(await tasks.remove(card.id)), { code: 'not-found' })
})

test('accept from triage, and link a session that moves the card to in progress', async (t) => {
  const seed = JSON.stringify(board([task({ id: 'tri', status: 'triage' })], { openCycle: '2026-W42' }))
  const { tasks } = await harness(t, { timeZone: ZONE }, seed)
  assert.equal(tasks.board().triage, 1)
  assert.equal(ok(await tasks.accept('tri', { to: 'todo' })).status, 'todo')
  const linked = ok(await tasks.linkSession('tri', { host: null, sessionId: '01920000-0000-7000-8000-000000000000' }))
  assert.equal(linked.status, 'in_progress')
  assert.equal(linked.sessions.length, 1)
})

test('a week later the board asks to close; closing archives and the history lists it (criteria 15–18)', async (t) => {
  const { tasks, clock } = await harness(t)
  const doing = ok(await tasks.create({ title: 'doing', status: 'todo' }))
  const finished = ok(await tasks.create({ title: 'finished', status: 'todo' }))
  ok(await tasks.move(finished.id, { status: 'done' }))

  clock.now = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000)
  const view = tasks.board()
  assert.equal(view.needsClose, true)
  assert.equal(view.openCycle, '2026-W42')
  assert.equal(view.currentCycle, '2026-W43')

  const closed = ok(await tasks.closeCycles({ from: '2026-W42' }))
  assert.deepEqual(
    closed.map((c) => c.id),
    ['2026-W42'],
  )
  assert.equal(tasks.board().needsClose, false)
  assert.equal(tasks.get(doing.id)?.cycle, '2026-W43')
  // A card of a closed cycle is still found by id (GET /tasks/:id), and in its cycle.
  assert.equal(tasks.get(finished.id)?.status, 'done')
  assert.equal(tasks.cycle('2026-W42')?.done[0]?.id, finished.id)
  assert.equal(tasks.cycle('2026-W30'), undefined)
  assert.deepEqual(
    tasks.cycles().map((c) => [c.id, c.done, c.carried]),
    [['2026-W42', 1, 1]],
  )
  assert.deepEqual(errorOf(await tasks.closeCycles({ from: '2026-W42' })), { code: 'conflict' })
})

test('the members of the second cut answer not-yet, and the agent lists no tool', async (t) => {
  const { tasks } = await harness(t)
  assert.deepEqual(errorOf(await tasks.capture({ text: 'x' })), { code: 'not-yet' })
  assert.deepEqual(errorOf(tasks.runNext()), { code: 'not-yet' })
  assert.deepEqual(tasks.agent.tools(), [])
  const result = await tasks.agent.call({ sessionId: 's', siteId: 'x', toolUseId: undefined, name: 'create_task', raw: {} })
  assert.equal(result.isError, true)
})

test('stop waits for the writes in flight', async (t) => {
  const { tasks, dir } = await harness(t)
  const pending = tasks.create({ title: 'late', status: 'backlog' })
  await tasks.stop()
  const card = ok(await pending)
  assert.ok((await readFile(join(dir, BOARD_FILE), 'utf8')).includes(card.id))
})

test('the log of a create carries no title (criterion 41)', async (t) => {
  const { tasks, log } = await harness(t)
  ok(await tasks.create({ title: 'SECRET-TITLE', status: 'backlog', notes: 'SECRET-NOTES' }))
  assert.ok(!log.lines.some((line) => line.includes('SECRET')))
})

// --- what does not start -------------------------------------------------------------------

async function refused(config: unknown, seed?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tasks-facade-'))
  try {
    if (seed !== undefined) await writeFile(join(dir, BOARD_FILE), seed)
    const created = await createTasks({ config, stateDir: dir, log: captureLog(), now: () => NOW, timers: fakeTimers(), notify: silentNotify })
    assert.equal(created.ok, false)
    return created.ok ? '' : created.reason
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a bad block does not start, with the reason of the config (criterion 1)', async () => {
  assert.match(await refused({ timeZone: 'Mars/Olympus' }), /^tasks\.timeZone:/)
})

test('relay mode does not start in the first cut, and says why', async () => {
  assert.match(await refused({ mode: 'relay', relayTo: 'omarchy' }), /relay/)
})

test('a damaged board does not start (criterion 3)', async () => {
  assert.match(await refused({}, '{not json'), /board\.json is damaged/)
})

// --- the link (design D1) --------------------------------------------------------------------

test('the link lists nothing until filled, and nothing after it is cleared', async () => {
  const link = createTasksLink()
  assert.deepEqual(link.family.tools(), [])
  const empty = await link.family.call({ sessionId: 's', siteId: 'x', toolUseId: undefined, name: 'create_task', raw: {} })
  assert.equal(empty.isError, true)

  const tool = { name: 'create_task', description: 'd', inputSchema: {} }
  link.fill({ tools: () => [tool], call: async () => ({ content: [{ type: 'text', text: 'done' }] }) })
  assert.deepEqual(link.family.tools(), [tool])
  assert.equal((await link.family.call({ sessionId: 's', siteId: 'x', toolUseId: undefined, name: 'create_task', raw: {} })).content[0]?.text, 'done')

  link.clear()
  assert.deepEqual(link.family.tools(), [])
})
