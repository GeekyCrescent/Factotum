import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Mockup, Step } from '../types.ts'
import type { Api } from './contract.ts'
import { checkLiveRuns } from './runs.ts'

const SESSION = '0192f3a4-5b6c-7d8e-9f01-23456789abcd'
const locked: Step = { status: 'locked', version: 0, history: [] }
function mockupWith(brief: Partial<Step>): Mockup {
  return {
    id: 'm1', name: 'N', client: 'C', project: 'p', vaultDir: '/v', workDir: '/w', buildSiteId: null, createdAt: 'a', updatedAt: 'a',
    stages: { brief: { ...locked, ...brief }, concepts: locked, plan: locked, build: locked, deliver: locked }, changes: [], inputs: [], urls: {}, status: 'open',
  }
}
const RUN = { id: 'r1', kind: 'brief' as const, siteId: 'personal', startedAt: '2026-11-12T00:00:00Z', sessionId: SESSION }

function apis(state: string | Error | 'hang', calls: string[]) {
  const sessions: Api = {
    get: async <T,>(path: string) => {
      calls.push(`GET ${path}`)
      if (state === 'hang') return await new Promise<T>(() => undefined)
      if (state instanceof Error) throw state
      return { summary: { state } } as T
    },
    post: async <T,>() => ({}) as T,
  }
  const mockups: Api = {
    get: async <T,>() => ({}) as T,
    post: async <T,>(path: string) => {
      calls.push(`POST ${path}`)
      return {} as T
    },
  }
  return { mockups, sessions }
}

test('crit. 17: a linked run whose session finished, failed or was cancelled is stalled when the mockup opens', async () => {
  for (const state of ['finished', 'failed', 'cancelled']) {
    const calls: string[] = []
    assert.equal(await checkLiveRuns(apis(state, calls), mockupWith({ status: 'running', run: RUN })), 1, state)
    assert.deepEqual(calls, [`GET sessions/${SESSION}`, 'POST runs/r1/stall'])
  }
})

test('a running session, an unlinked run or a stalled one is left alone', async () => {
  const calls: string[] = []
  assert.equal(await checkLiveRuns(apis('running', calls), mockupWith({ status: 'running', run: RUN })), 0)
  const { sessionId: _s, ...unlinked } = RUN
  assert.equal(await checkLiveRuns(apis('finished', calls), mockupWith({ status: 'running', run: unlinked })), 0)
  assert.equal(await checkLiveRuns(apis('finished', calls), mockupWith({ status: 'stalled', run: RUN })), 0)
  assert.deepEqual(calls, [`GET sessions/${SESSION}`])
})

test('a session sessions no longer has (404) counts as ended; an unreachable one does not', async () => {
  const gone: string[] = []
  assert.equal(await checkLiveRuns(apis(Object.assign(new Error('no'), { status: 404 }), gone), mockupWith({ status: 'running', run: RUN })), 1)
  const down: string[] = []
  assert.equal(await checkLiveRuns(apis(new Error('network'), down), mockupWith({ status: 'running', run: RUN })), 0)
})

test('crit. 17: the check gives up on a session after 5 s', async () => {
  const calls: string[] = []
  const started = Date.now()
  assert.equal(await checkLiveRuns(apis('hang', calls), mockupWith({ status: 'running', run: RUN }), 50), 0)
  assert.ok(Date.now() - started < 1000)
})

test('crit. 17, 36: a change’s linked run whose session ended is stalled too', async () => {
  const calls: string[] = []
  const m = { ...mockupWith({}), changes: [{ id: 'c1', text: 't', phase: 'change' as const, status: 'running' as const, version: 0, history: [], run: { ...RUN, id: 'x1', kind: 'change' as const } }] }
  assert.equal(await checkLiveRuns(apis('finished', calls), m), 1)
  assert.ok(calls.includes('POST runs/x1/stall'))
})
