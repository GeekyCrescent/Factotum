import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Api } from './contract.ts'
import { pollRequest, reconcileProject, requestProject } from './project.ts'

const M = { id: 'm1', name: 'Alta GMM', workDir: '/Users/me/BWR/Projects/AltaGMM', buildSiteId: null }
type Answer = (body: unknown) => unknown
function fakeApi(calls: string[], name: string, answers: Readonly<Record<string, Answer>>): Api {
  const answer = async (method: string, path: string, body?: unknown) => {
    calls.push(`${name} ${method} ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`)
    const handler = answers[`${method} ${path}`]
    if (handler === undefined) throw Object.assign(new Error(`no fake for ${method} ${path}`), { status: 404 })
    return handler(body)
  }
  return { get: async <T,>(path: string) => (await answer('GET', path)) as T, post: async <T,>(path: string, body?: unknown) => (await answer('POST', path, body)) as T }
}
const fail = (status: number, message: string, body: unknown = {}) => () => {
  throw Object.assign(new Error(message), { status, body })
}
const PROJECTS = { projects: [{ id: 'alta', path: '/users/me/bwr/projects/altagmm' }], shared: [] }

test('crit. 7: a work-dir that is (or is inside) a sessions project is used without asking', async () => {
  const calls: string[] = []
  const sessions = fakeApi(calls, 'sessions', { 'GET projects': () => PROJECTS })
  const mockups = fakeApi(calls, 'mockups', { 'POST mockups/m1/site-match': () => ({ siteId: 'alta' }), 'POST mockups/m1/site': () => ({}) })
  assert.deepEqual(await reconcileProject({ mockups, sessions }, M), { kind: 'found', siteId: 'alta' })
  assert.deepEqual(calls, [
    'sessions GET projects',
    'mockups POST mockups/m1/site-match {"projects":[{"id":"alta","path":"/users/me/bwr/projects/altagmm"}]}',
    'mockups POST mockups/m1/site {"siteId":"alta"}',
  ])
})

test('no match: nothing is asked until the owner taps Request', async () => {
  const calls: string[] = []
  const sessions = fakeApi(calls, 'sessions', { 'GET projects': () => ({ projects: [], shared: [] }) })
  const mockups = fakeApi(calls, 'mockups', { 'POST mockups/m1/site-match': () => ({ siteId: null }) })
  assert.deepEqual(await reconcileProject({ mockups, sessions }, M), { kind: 'none' })
})

test('crit. 7: requesting the project waits for approval on the phone', async () => {
  const calls: string[] = []
  const sessions = fakeApi(calls, 'sessions', { 'POST projects': () => ({ requestId: 'q1', expiresAt: 'x' }) })
  const mockups = fakeApi(calls, 'mockups', {})
  assert.deepEqual(await requestProject({ mockups, sessions }, M), { kind: 'waiting', requestId: 'q1' })
  assert.deepEqual(calls, ['sessions POST projects {"path":"/Users/me/BWR/Projects/AltaGMM","name":"Alta GMM"}'])
})

test('crit. 7: a 409 no-device or too-many leaves Request again with the reason', async () => {
  const calls: string[] = []
  const sessions = fakeApi(calls, 'sessions', { 'POST projects': fail(409, 'no device can approve it right now', { request: { conflict: 'no-device' } }) })
  const state = await requestProject({ mockups: fakeApi(calls, 'mockups', {}), sessions }, M)
  assert.deepEqual(state, { kind: 'again', reason: 'no device can approve it right now' })
})

test('crit. 7: a 400 is no build project, with the reason kept on the mockup; the vault stages go on', async () => {
  const calls: string[] = []
  const sessions = fakeApi(calls, 'sessions', { 'POST projects': fail(400, 'it is inside the project bwr') })
  const mockups = fakeApi(calls, 'mockups', { 'POST mockups/m1/site': () => ({}) })
  assert.deepEqual(await requestProject({ mockups, sessions }, M), { kind: 'refused', reason: 'it is inside the project bwr' })
  assert.equal(calls.at(-1), 'mockups POST mockups/m1/site {"refused":"it is inside the project bwr"}')
})

test('polling: pending waits; approved reconciles; denied, expired and rejected are Request again', async () => {
  const states: Record<string, unknown> = { pending: { status: 'pending' }, approved: { status: 'approved' }, denied: { status: 'denied' }, expired: { status: 'expired' } }
  for (const [name, answer] of Object.entries(states)) {
    const calls: string[] = []
    const sessions = fakeApi(calls, 'sessions', { 'GET projects/requests/q1': () => answer, 'GET projects': () => PROJECTS })
    const mockups = fakeApi(calls, 'mockups', { 'POST mockups/m1/site-match': () => ({ siteId: 'alta' }), 'POST mockups/m1/site': () => ({}) })
    const state = await pollRequest({ mockups, sessions }, M, 'q1')
    const expected = { pending: { kind: 'waiting', requestId: 'q1' }, approved: { kind: 'found', siteId: 'alta' }, denied: { kind: 'again', reason: 'the request was denied' }, expired: { kind: 'again', reason: 'the request expired after 10 minutes' } }[name]
    assert.deepEqual(state, expected, name)
  }
})

test('a request sessions no longer knows (404) is Request again', async () => {
  const calls: string[] = []
  const sessions = fakeApi(calls, 'sessions', { 'GET projects/requests/q1': fail(404, 'there is no request with that id') })
  assert.deepEqual(await pollRequest({ mockups: fakeApi(calls, 'mockups', {}), sessions }, M, 'q1'), { kind: 'again', reason: 'there is no request with that id' })
})

test('without sessions there is nothing to find nor ask', async () => {
  assert.deepEqual(await reconcileProject({ mockups: fakeApi([], 'mockups', {}), sessions: undefined }, M), { kind: 'no-sessions' })
})
