import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentTools, CREATE_TASK, MAX_TASKS_PER_SESSION } from './agent.ts'
import { openBoardStore, type BoardStore } from './board/store.ts'
import { captureLog, counter, NOW, ZONE } from './test-support.ts'
import type { AgentCall, AgentToolImpl, AgentToolResult } from './types.ts'

const SESSION = '01920000-0000-7000-8000-00000000000a'

async function rig(t: { after: (fn: () => Promise<void>) => void }, dir?: string) {
  const folder = dir ?? (await mkdtemp(join(tmpdir(), 'tasks-agent-')))
  if (dir === undefined) t.after(() => rm(folder, { recursive: true, force: true }))
  const log = captureLog()
  const opened = await openBoardStore({ dir: folder, timeZone: ZONE, now: NOW, log })
  if (!opened.ok) throw new Error(opened.reason)
  const store: BoardStore = opened.store
  const newId = counter('a')
  const agent: AgentToolImpl = createAgentTools({ store, opContext: () => ({ now: NOW, timeZone: ZONE, newId }), log })
  return { store, agent, log, dir: folder }
}

const call = (raw: unknown, over: Partial<AgentCall> = {}): AgentCall => ({ sessionId: SESSION, siteId: 'web', toolUseId: 'tu1', name: CREATE_TASK, raw, ...over })

const textOf = (result: AgentToolResult): string => result.content.map((c) => c.text).join('')

test('the tool: create_task, its limits in the schema, and the cap in the description', async (t) => {
  const { agent } = await rig(t)
  const [tool] = agent.tools()
  assert.equal(tool?.name, 'create_task')
  assert.match(tool?.description ?? '', /Triage/)
  assert.match(tool?.description ?? '', /At most 10 per session/)
  const schema = tool?.inputSchema as { properties: Record<string, { maxLength?: number; maximum?: number }>; required: string[]; additionalProperties: boolean }
  assert.deepEqual(schema.required, ['title'])
  assert.equal(schema.properties.title?.maxLength, 200)
  assert.equal(schema.properties.notes?.maxLength, 4000)
  assert.equal(schema.properties.area?.maxLength, 40)
  assert.equal(schema.properties.priority?.maximum, 4)
  assert.equal(schema.additionalProperties, false)
})

test('crit. 26: a card in triage with origin agent, the session, the project and the board host (null)', async (t) => {
  const { agent, store } = await rig(t)
  const result = await agent.call(call({ title: 'Review the release notes', notes: 'Before Friday', area: 'BWR', due: '2026-10-16', priority: 2 }))
  assert.equal(result.isError, undefined)
  assert.equal(textOf(result), 'Added to the owner\'s Triage as "Review the release notes" (1 of 10).')
  const card = store.current().tasks[0]
  assert.equal(card?.status, 'triage')
  assert.equal(card?.cycle, null)
  assert.deepEqual(card?.source, { kind: 'agent', host: null, sessionId: SESSION, siteId: 'web' })
  assert.deepEqual(card?.project, { host: null, siteId: 'web' })
  assert.equal(card?.area, 'BWR')
  assert.equal(card?.due, '2026-10-16')
  assert.equal(card?.priority, 2)
  assert.equal(card?.notes, 'Before Friday')
  assert.equal(store.current().agentCounts[SESSION], 1)
})

test(`crit. 27: the ${MAX_TASKS_PER_SESSION + 1}th call is an isError that says to stop, and nothing is written`, async (t) => {
  const { agent, store } = await rig(t)
  for (let i = 1; i <= MAX_TASKS_PER_SESSION; i++) assert.equal((await agent.call(call({ title: `task ${i}` }))).isError, undefined)
  const eleventh = await agent.call(call({ title: 'one too many' }))
  assert.equal(eleventh.isError, true)
  assert.match(textOf(eleventh), /10 tasks/)
  assert.match(textOf(eleventh), /stop/i)
  assert.match(textOf(eleventh), /reply/)
  assert.equal(store.current().tasks.length, MAX_TASKS_PER_SESSION)
  // Another session has its own ten.
  assert.equal((await agent.call(call({ title: 'other' }, { sessionId: '01920000-0000-7000-8000-00000000000b' }))).isError, undefined)
})

test('crit. 27: the count survives a restart — it lives on the board', async (t) => {
  const first = await rig(t)
  for (let i = 1; i <= MAX_TASKS_PER_SESSION; i++) await first.agent.call(call({ title: `task ${i}` }))
  await first.store.idle()
  const again = await rig(t, first.dir)
  const refused = await again.agent.call(call({ title: 'after the restart' }))
  assert.equal(refused.isError, true)
})

test('crit. 28: a bad input is an isError naming the field, and nothing is written', async (t) => {
  const { agent, store } = await rig(t)
  const cases: [unknown, RegExp][] = [
    [{}, /title/],
    [{ title: '' }, /title/],
    [{ title: 'x'.repeat(201) }, /title/],
    [{ title: 'x', due: 'friday' }, /due/],
    [{ title: 'x', priority: 9 }, /priority/],
    [{ title: 'x', area: 'a'.repeat(41) }, /area/],
    [{ title: 'x', status: 'done' }, /status/],
    ['not an object', /object/],
  ]
  for (const [raw, field] of cases) {
    const result = await agent.call(call(raw))
    assert.equal(result.isError, true, JSON.stringify(raw))
    assert.match(textOf(result), field)
  }
  assert.equal(store.current().tasks.length, 0)
  assert.equal(store.current().agentCounts[SESSION], undefined)
})

test('another name is an isError, and a call never throws', async (t) => {
  const { agent } = await rig(t)
  const other = await agent.call(call({ title: 'x' }, { name: 'delete_task' }))
  assert.equal(other.isError, true)
})

test('crit. 41: the log says a card was created, by id and session, never with its title', async (t) => {
  const { agent, log } = await rig(t)
  await agent.call(call({ title: 'SECRET TITLE', notes: 'SECRET NOTES' }))
  assert.equal(log.lines.some((line) => line.includes('SECRET')), false)
  assert.ok(log.lines.some((line) => line.includes('create_task') && line.includes(SESSION)))
})
