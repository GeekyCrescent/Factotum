import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PeerCaller, PeerResponse } from '@factotum/core'
import { createTasks } from './tasks.ts'
import { captureLog, fakeTimers, NOW, silentNotify, ZONE } from './test-support.ts'
import type { AgentCall, AgentToolResult, TasksDeps } from './types.ts'

const SESSION = '01920000-0000-7000-8000-00000000000a'
const call = (raw: unknown): AgentCall => ({ sessionId: SESSION, siteId: 'notes', toolUseId: undefined, name: 'create_task', raw })
const textOf = (result: AgentToolResult): string => result.content.map((c) => c.text).join('')

function peers(answer: (path: string, body: unknown) => PeerResponse<unknown>, names = ['omarchy']): PeerCaller & { readonly sent: { path: string; body: unknown; timeoutMs: number | undefined }[] } {
  const sent: { path: string; body: unknown; timeoutMs: number | undefined }[] = []
  return {
    sent,
    list: () => names.map((name) => ({ name, reachable: true })),
    json: async <T>(_peer: string, _method: 'GET' | 'POST', path: string, body?: unknown, options?: { timeoutMs?: number }) => {
      sent.push({ path, body, timeoutMs: options?.timeoutMs })
      return answer(path, body) as PeerResponse<T>
    },
    upload: async () => ({ ok: false, status: undefined, reason: 'refused', body: undefined }),
  }
}

async function make(t: { after: (fn: () => Promise<void>) => void }, config: unknown, over: Partial<TasksDeps> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tasks-relay-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const log = captureLog()
  const created = await createTasks({ config, stateDir: dir, log, now: () => NOW, timers: fakeTimers(), notify: silentNotify, ...over })
  return { created, log, dir }
}

// --- relay mode (the Mac): no board, a where, and create_task forwarded (R0b, R1, R2) -------

test('R0b: relay mode starts without a board, and says where the board lives', async (t) => {
  const { created } = await make(t, { mode: 'relay', relayTo: 'omarchy' }, { peers: peers(() => ({ ok: true, status: 200, body: {} })) })
  assert.equal(created.ok, true)
  assert.ok(created.ok && 'relay' in created)
  if (!created.ok || !('relay' in created)) return
  assert.deepEqual(created.relay.where(), { mode: 'relay', host: 'omarchy' })
})

test('R1, crit. 29: create_task is checked here, then forwarded to the board host’s agent-tasks with the session', async (t) => {
  const answer: AgentToolResult = { content: [{ type: 'text', text: 'Added to the owner\'s Triage as "x" (1 of 10).' }] }
  const caller = peers(() => ({ ok: true, status: 200, body: answer }))
  const { created } = await make(t, { mode: 'relay', relayTo: 'omarchy' }, { peers: caller })
  if (!created.ok || !('relay' in created)) throw new Error('expected relay')
  assert.deepEqual(created.relay.agent.tools().map((tool) => tool.name), ['create_task'])
  const result = await created.relay.agent.call(call({ title: 'x', area: 'Vida' }))
  assert.deepEqual(result, answer)
  assert.deepEqual(caller.sent, [{ path: 'agent-tasks', body: { title: 'x', area: 'Vida', sessionId: SESSION, siteId: 'notes' }, timeoutMs: 10_000 }])
})

test('R1: a bad input is refused here, without spending a call to the board host', async (t) => {
  const caller = peers(() => ({ ok: true, status: 200, body: {} }))
  const { created } = await make(t, { mode: 'relay', relayTo: 'omarchy' }, { peers: caller })
  if (!created.ok || !('relay' in created)) throw new Error('expected relay')
  const result = await created.relay.agent.call(call({ title: '' }))
  assert.equal(result.isError, true)
  assert.equal(caller.sent.length, 0)
})

test('R1, crit. 29: unreachable, a timeout or an answer that is not a result is «the board is unreachable», never retried', async (t) => {
  for (const response of [
    { ok: false, status: undefined, reason: 'unreachable', body: undefined },
    { ok: false, status: undefined, reason: 'timeout', body: undefined },
    { ok: false, status: 500, reason: 'http', body: { error: 'x' } },
    { ok: true, status: 200, body: { not: 'a result' } },
  ] as const) {
    const caller = peers(() => response as PeerResponse<unknown>)
    const { created } = await make(t, { mode: 'relay', relayTo: 'omarchy' }, { peers: caller })
    if (!created.ok || !('relay' in created)) throw new Error('expected relay')
    const result = await created.relay.agent.call(call({ title: 'x' }))
    assert.equal(result.isError, true)
    assert.match(textOf(result), /board is unreachable; tell the owner in your reply/)
    assert.equal(caller.sent.length, 1)
  }
})

test('R2: without ctx.peers, relay lists no tool and says why, once', async (t) => {
  const { created, log } = await make(t, { mode: 'relay', relayTo: 'omarchy' })
  if (!created.ok || !('relay' in created)) throw new Error('expected relay')
  assert.deepEqual(created.relay.agent.tools(), [])
  assert.deepEqual(created.relay.agent.tools(), [])
  assert.equal(log.lines.filter((line) => line.includes('relay')).length, 1)
})

// --- board mode (omarchy): what a relay sends it ------------------------------------------

test('R1, S11: agent-tasks on the board files the card with the PEER as its host', async (t) => {
  const { created } = await make(t, { timeZone: ZONE }, { peers: peers(() => ({ ok: true, status: 200, body: {} }), ['mac']) })
  if (!created.ok || !('tasks' in created)) throw new Error('expected a board')
  const result = await created.tasks.fromPeer({ title: 'From the Mac', sessionId: SESSION, siteId: 'notes' })
  assert.equal(result.isError, undefined)
  const card = created.tasks.triage()[0]
  assert.deepEqual(card?.source, { kind: 'agent', host: 'mac', sessionId: SESSION, siteId: 'notes' })
  assert.deepEqual(card?.project, { host: 'mac', siteId: 'notes' })
  assert.deepEqual(created.tasks.where(), { mode: 'board' })
})

test('agent-tasks without a peer, or with a body that is not one, is an isError and writes nothing', async (t) => {
  const { created } = await make(t, { timeZone: ZONE })
  if (!created.ok || !('tasks' in created)) throw new Error('expected a board')
  assert.equal((await created.tasks.fromPeer({ title: 'x', sessionId: SESSION, siteId: 'notes' })).isError, true)
  const withPeer = await make(t, { timeZone: ZONE }, { peers: peers(() => ({ ok: true, status: 200, body: {} }), ['mac']) })
  if (!withPeer.created.ok || !('tasks' in withPeer.created)) throw new Error('expected a board')
  assert.equal((await withPeer.created.tasks.fromPeer({ title: 'x' })).isError, true)
  assert.equal((await withPeer.created.tasks.fromPeer('nope')).isError, true)
  assert.equal(withPeer.created.tasks.triage().length, 0)
})
