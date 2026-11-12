import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Api } from './contract.ts'
import { freePromptEntry, redoStage, startStage } from './launch.ts'

const SESSION = '0192f3a4-5b6c-7d8e-9f01-23456789abcd'
const TICKET = { runId: 'r1', siteId: 'personal', text: 'the prompt', title: 'Mockup · brief · Alta GMM', model: 'opus[1m]' }
const SETUP = { sites: [], catalog: [{ id: 'skill', label: 'S', disabledReason: undefined, kind: 'skill' }, { id: 'free', label: 'Free', disabledReason: undefined, kind: 'none' }] }

type Answer = (path: string, body: unknown) => unknown
function fakeApi(calls: string[], name: string, answers: Readonly<Record<string, Answer>>): Api {
  const answer = async (method: string, path: string, body?: unknown) => {
    calls.push(`${name} ${method} ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`)
    const handler = answers[`${method} ${path}`]
    if (handler === undefined) throw Object.assign(new Error(`no fake for ${method} ${path}`), { status: 404 })
    return handler(path, body)
  }
  return { get: async <T,>(path: string) => (await answer('GET', path)) as T, post: async <T,>(path: string, body?: unknown) => (await answer('POST', path, body)) as T }
}

const mockupsOk = (calls: string[]) =>
  fakeApi(calls, 'mockups', {
    'POST mockups/m1/runs': () => TICKET,
    'POST mockups/m1/decision': () => ({ mockup: {}, run: TICKET }),
    'POST runs/r1/session': () => ({}),
    'POST runs/r1/abandon': () => ({}),
  })

test('freePromptEntry: the first enabled entry of kind none (a copy of tasks’, D5)', () => {
  assert.equal(freePromptEntry(SETUP.catalog), 'free')
  assert.equal(freePromptEntry([{ id: 'x', label: 'x', disabledReason: 'off', kind: 'none' }]), undefined)
})

test('crit. 14 / D5: run, launch with force and the model, link, then the title — in that order', async () => {
  const calls: string[] = []
  const sessions = fakeApi(calls, 'sessions', {
    'GET setup': () => SETUP,
    'POST sessions': () => ({ sessionId: SESSION }),
    [`POST sessions/${SESSION}/title`]: () => ({}),
  })
  const outcome = await startStage({ mockups: mockupsOk(calls), sessions }, 'm1', 'brief')
  assert.deepEqual(outcome, { ok: true, sessionId: SESSION, titled: true })
  assert.deepEqual(calls, [
    'mockups POST mockups/m1/runs {"kind":"brief"}',
    'sessions GET setup',
    'sessions POST sessions {"siteId":"personal","entryId":"free","text":"the prompt","force":true,"model":"opus[1m]"}',
    `mockups POST runs/r1/session {"sessionId":"${SESSION}"}`,
    `sessions POST sessions/${SESSION}/title {"title":"Mockup · brief · Alta GMM"}`,
  ])
})

test('crit. 15: a launch refused with 409 abandons the run and says who is busy', async () => {
  const calls: string[] = []
  const busy = Object.assign(new Error('the project has a live session'), { status: 409, body: { error: { code: 'conflict' }, conflict: { sessionId: SESSION } } })
  const sessions = fakeApi(calls, 'sessions', {
    'GET setup': () => SETUP,
    'POST sessions': () => {
      throw busy
    },
  })
  const outcome = await startStage({ mockups: mockupsOk(calls), sessions }, 'm1', 'brief')
  assert.equal(outcome.ok, false)
  assert.ok(calls.includes('mockups POST runs/r1/abandon {"reason":"launch refused (409)"}'))
})

test('crit. 41: without sessions nothing is created', async () => {
  const calls: string[] = []
  const outcome = await startStage({ mockups: mockupsOk(calls), sessions: undefined }, 'm1', 'brief')
  assert.deepEqual(outcome, { ok: false, problem: { kind: 'rejected', message: 'sessions is not running on this host' } })
  assert.deepEqual(calls, [])
})

test('the run refused by the module (409 a run alive) is said, and nothing is launched', async () => {
  const calls: string[] = []
  const mockups = fakeApi(calls, 'mockups', {
    'POST mockups/m1/runs': () => {
      throw Object.assign(new Error('the brief stage already has a run'), { status: 409 })
    },
  })
  const sessions = fakeApi(calls, 'sessions', {})
  const outcome = await startStage({ mockups, sessions }, 'm1', 'brief')
  assert.deepEqual(outcome, { ok: false, problem: { kind: 'rejected', message: 'the brief stage already has a run' } })
  assert.deepEqual(calls, ['mockups POST mockups/m1/runs {"kind":"brief"}'])
})

test('no free-prompt entry on the host: the run is abandoned', async () => {
  const calls: string[] = []
  const sessions = fakeApi(calls, 'sessions', { 'GET setup': () => ({ sites: [], catalog: [] }) })
  const outcome = await startStage({ mockups: mockupsOk(calls), sessions }, 'm1', 'brief')
  assert.equal(outcome.ok, false)
  assert.ok(calls.includes('mockups POST runs/r1/abandon {"reason":"no free-prompt entry"}'))
})

test('a title that fails does not undo a launch: the session runs, and the screen says the title is missing', async () => {
  const calls: string[] = []
  const sessions = fakeApi(calls, 'sessions', { 'GET setup': () => SETUP, 'POST sessions': () => ({ sessionId: SESSION }) })
  const outcome = await startStage({ mockups: mockupsOk(calls), sessions }, 'm1', 'brief')
  assert.deepEqual(outcome, { ok: true, sessionId: SESSION, titled: false })
})

test('crit. 29: a redo is the decision with its comment, then the same launch', async () => {
  const calls: string[] = []
  const sessions = fakeApi(calls, 'sessions', {
    'GET setup': () => SETUP,
    'POST sessions': () => ({ sessionId: SESSION }),
    [`POST sessions/${SESSION}/title`]: () => ({}),
  })
  const outcome = await redoStage({ mockups: mockupsOk(calls), sessions }, 'm1', 'brief', 'más detalle')
  assert.equal(outcome.ok, true)
  assert.equal(calls[0], 'mockups POST mockups/m1/decision {"step":"brief","action":"redo","comment":"más detalle"}')
})

test('crit. 15: the notice of a busy launch carries the session in the way, to open it', async () => {
  const { noticeOf } = await import('./launch.ts')
  assert.deepEqual(noticeOf({ ok: false, problem: { kind: 'busy', sessionId: SESSION } }), {
    text: 'The project already has a session running, so the stage is back where it was.',
    sessionId: SESSION,
  })
  assert.equal(noticeOf({ ok: true, sessionId: SESSION, titled: true }), undefined)
  assert.deepEqual(noticeOf({ ok: true, sessionId: SESSION, titled: false }), { text: 'The session started, but its title could not be set.' })
  assert.deepEqual(noticeOf({ ok: false, problem: { kind: 'rejected', message: 'no model' } }), { text: 'no model' })
})
