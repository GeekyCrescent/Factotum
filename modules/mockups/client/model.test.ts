import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Mockup, StageId, Step } from '../types.ts'
import { afterDecision, safeUrl, crossWrites, galleryOrder, inputsBlocked, launchBlocked, nowStage, offersAbandon, stageActions, statusLine, STARTING_OFFER_MS } from './model.ts'

const NOW = new Date('2026-11-12T10:00:00.000Z')
const SESSION = '0192f3a4-5b6c-7d8e-9f01-23456789abcd'
const locked: Step = { status: 'locked', version: 0, history: [] }

function mockup(id: string, stages: Partial<Record<StageId, Partial<Step>>> = {}, over: Partial<Mockup> = {}): Mockup {
  const all = { brief: { ...locked, status: 'ready' as const }, concepts: locked, plan: locked, build: locked, deliver: locked }
  const merged = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { ...v, ...(stages[k as StageId] ?? {}) }])) as Record<StageId, Step>
  return {
    id, name: id, client: 'C', project: 'p', vaultDir: '/v', workDir: '/w', buildSiteId: null,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), stages: merged, changes: [], inputs: [], urls: {}, status: 'open', ...over,
  }
}
const run = (minutesAgo: number, sessionId?: string) => ({
  id: 'r1', kind: 'brief' as const, siteId: 'personal', startedAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(), ...(sessionId === undefined ? {} : { sessionId }),
})

test('crit. 38: the gallery puts waiting on you first, then stalled, then running, then the rest, newest first in each', () => {
  const list = [
    mockup('rest-old', {}, { updatedAt: '2026-11-01T00:00:00Z' }),
    mockup('running', { brief: { status: 'running', run: run(1) } }),
    mockup('stalled', { brief: { status: 'stalled', run: run(30) } }),
    mockup('waiting', { brief: { status: 'waiting', version: 1 } }),
    mockup('rest-new', {}, { updatedAt: '2026-11-11T00:00:00Z' }),
  ]
  assert.deepEqual(galleryOrder(list).map((m) => m.id), ['waiting', 'stalled', 'running', 'rest-new', 'rest-old'])
})

test('nowStage: the first stage that is not done, or deliver when all are', () => {
  assert.equal(nowStage(mockup('a')), 'brief')
  assert.equal(nowStage(mockup('a', { brief: { status: 'done' }, concepts: { status: 'ready' } })), 'concepts')
  const all = mockup('a', { brief: { status: 'done' }, concepts: { status: 'done' }, plan: { status: 'done' }, build: { status: 'done' }, deliver: { status: 'done' } })
  assert.equal(nowStage(all), 'deliver')
})

test('statusLine says the status and the version', () => {
  assert.equal(statusLine({ status: 'waiting', version: 2, history: [] }), 'waiting on you · v2')
  assert.equal(statusLine({ status: 'stalled', version: 0, history: [] }), 'stalled: the session ended without submitting')
  assert.equal(statusLine({ status: 'ready', version: 0, history: [] }), 'ready')
  assert.equal(statusLine({ status: 'done', version: 1, history: [] }), 'done · v1')
})

test('crit. 41: without sessions on the module’s host, launching is off with the reason; reading and deciding are not', () => {
  const m = mockup('a', { brief: { status: 'waiting', version: 1 } })
  assert.match(launchBlocked(m, 'brief', { sessions: false }) ?? '', /sessions is not running on this host/)
  const actions = stageActions(m, 'brief', { sessions: false, now: NOW })
  assert.equal(actions.approve, true)
  assert.match(actions.redo.disabled ?? '', /sessions/)
})

test('crit. 19: another run alive in the mockup blocks a start, with its stage named', () => {
  const m = mockup('a', { brief: { status: 'done' }, concepts: { status: 'running', run: { ...run(1), kind: 'concepts' } } })
  assert.match(launchBlocked(m, 'plan', { sessions: true }) ?? '', /concepts is running/)
})

test('a stage of a later block is shown and cannot start (E4); concepts now can', () => {
  const m = mockup('a', { brief: { status: 'done' }, concepts: { status: 'done' }, plan: { status: 'ready' } })
  assert.equal(stageActions(m, 'plan', { sessions: true, now: NOW }).start?.disabled, 'next cut')
  const c = mockup('a', { brief: { status: 'done' }, concepts: { status: 'ready' } })
  assert.equal(stageActions(c, 'concepts', { sessions: true, now: NOW }).start?.disabled, undefined)
})

test('crit. 28: a choosing gate offers choose, not approve; an approving gate the other way round', () => {
  const options = [{ id: 'a', title: 'A', blurb: 'a' }, { id: 'b', title: 'B', blurb: 'b' }]
  const c = stageActions(mockup('a', { brief: { status: 'done' }, concepts: { status: 'waiting', version: 1, options } }), 'concepts', { sessions: true, now: NOW })
  assert.equal(c.gate, 'choose')
  assert.equal(c.approve, false)
  assert.equal(c.choose, true)
  const b = stageActions(mockup('a', { brief: { status: 'waiting', version: 1 } }), 'brief', { sessions: true, now: NOW })
  assert.equal(b.gate, 'approve')
  assert.equal(b.approve, true)
  assert.equal(b.choose, false)
})

test('crit. 27, 28: after approving or choosing, the screen launches the next stage only if this cut launches it', () => {
  assert.equal(afterDecision('brief'), 'concepts')
  assert.equal(afterDecision('concepts'), undefined)
  assert.equal(afterDecision('deliver'), undefined)
})

test('a work-dir stage without a build project says why', () => {
  const m = mockup('a', { build: { status: 'ready' } }, { buildRefused: 'it is inside a project' })
  assert.match(launchBlocked(m, 'build', { sessions: true }) ?? '', /no build project: it is inside a project/)
})

test('ready brief: Start, enabled', () => {
  assert.deepEqual(stageActions(mockup('a'), 'brief', { sessions: true, now: NOW }).start, { disabled: undefined })
})

test('crit. 17: a stalled run with a session offers Open session and Retry', () => {
  const m = mockup('a', { brief: { status: 'stalled', run: run(30, SESSION) } })
  const actions = stageActions(m, 'brief', { sessions: true, now: NOW })
  assert.equal(actions.openSession, SESSION)
  assert.deepEqual(actions.retry, { disabled: undefined })
  assert.equal(actions.abandon, false)
})

test('crit. 18: a run without a session offers Abandon only after 2 min', () => {
  assert.equal(offersAbandon(run(1), NOW), false)
  assert.equal(offersAbandon(run(STARTING_OFFER_MS / 60_000), NOW), true)
  assert.equal(offersAbandon(run(5, SESSION), NOW), false)
  const m = mockup('a', { brief: { status: 'running', run: run(3) } })
  assert.equal(stageActions(m, 'brief', { sessions: true, now: NOW }).abandon, true)
})

test('crit. 12: inputs are closed while a stage runs, with the reason', () => {
  assert.equal(inputsBlocked(mockup('a')), undefined)
  assert.match(inputsBlocked(mockup('a', { brief: { status: 'running', run: run(1) } })) ?? '', /brief is running/)
})

test('crit. 2b: the warning when the vault stages cannot write in projectsDir, or the cross writes have no shared folder', () => {
  const setup = { docsSiteId: 'personal', projectsDir: '/Users/me/vault/01-projects', workRoot: '/Users/me/BWR/Projects', crossWritesAllowed: false }
  const projects = [{ id: 'personal', path: '/Users/me/vault' }]
  assert.equal(crossWrites(setup, { projects, shared: [{ path: '/Users/me/BWR' }, { path: '/Users/me/vault' }] }, true), undefined)
  assert.match(crossWrites(setup, { projects, shared: [] }, true) ?? '', /stage sessions will ask before writing outside their project/i)
  assert.equal(crossWrites({ ...setup, crossWritesAllowed: true }, { projects, shared: [] }, true), undefined)
  assert.match(crossWrites(setup, { projects: [{ id: 'personal', path: '/elsewhere' }], shared: [{ path: '/Users/me' }] }, true) ?? '', /ask/)
  assert.equal(crossWrites(setup, { projects: [{ id: 'personal', path: '/users/me/VAULT' }], shared: [{ path: '/users/me' }] }, true), undefined)
})

test('an option url becomes a link only if it is https (the server checks too; the screen does not trust it)', () => {
  assert.equal(safeUrl('https://acme-directions-abc.vercel.app/a.html'), 'https://acme-directions-abc.vercel.app/a.html')
  assert.equal(safeUrl('javascript:alert(1)'), undefined)
  assert.equal(safeUrl('http://example.com'), undefined)
  assert.equal(safeUrl('not a url'), undefined)
  assert.equal(safeUrl(undefined), undefined)
})
