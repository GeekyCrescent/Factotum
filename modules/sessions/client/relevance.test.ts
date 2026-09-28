import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionState, SessionSummary } from '../types.ts'
import { askFor, pickRelevant, resolvedBy, type Pending } from './relevance.ts'

const TOKEN = 'a'.repeat(43)

const session = (id: string, state: SessionState, startedAt: string): SessionSummary => ({
  id,
  siteId: 'demo',
  entryId: 'free',
  state,
  startedAt,
  endedAt: undefined,
  reason: undefined,
  turns: 1,
  prompt: undefined,
})
const pending = (sessionId: string, askId?: string): Pending => ({
  tag: `ask:${sessionId}`,
  until: '2099-01-01T00:00:00.000Z',
  data: askId === undefined ? { sessionId, siteId: 'demo', toolName: 'Write', file: 'a.txt' } : { askId, sessionId, siteId: 'demo', toolName: 'Write', file: 'a.txt' },
})

const OLD = '2026-09-18T10:00:00.000Z'
const NEW = '2026-09-19T10:00:00.000Z'
const NEWER = '2026-09-19T11:00:00.000Z'

test('first rule: the session of a live pending (criterion 13)', () => {
  const page = [session('a', 'running', NEWER), session('b', 'running', OLD)]
  assert.deepEqual(pickRelevant([pending('b')], page), { kind: 'session', id: 'b' })
})

test('otherwise the most recent RUNNING one, even if a finished one is newer', () => {
  const page = [session('done', 'finished', NEWER), session('old', 'running', OLD), session('new', 'running', NEW)]
  assert.deepEqual(pickRelevant([], page), { kind: 'session', id: 'new' })
})

test('otherwise the most recent of all', () => {
  const page = [session('a', 'finished', OLD), session('b', 'failed', NEW)]
  assert.deepEqual(pickRelevant([], page), { kind: 'session', id: 'b' })
})

test('with no session at all, a new one', () => {
  assert.deepEqual(pickRelevant([], []), { kind: 'new' })
})

test('a pending whose session is no longer running is resolved; one still running, or not in the page, stays (criterion 28)', () => {
  const page = [session('done', 'finished', NEW), session('live', 'running', NEW)]
  assert.deepEqual(resolvedBy([pending('done'), pending('live'), pending('elsewhere')], page), ['ask:done'])
})

test('the ask for a session: its pending first, then the token the page loaded with', () => {
  assert.deepEqual(askFor('s1', [pending('s1', TOKEN)], ''), {
    tag: 'ask:s1',
    askId: TOKEN,
    sessionId: 's1',
    siteId: 'demo',
    toolName: 'Write',
    file: 'a.txt',
  })
  assert.deepEqual(askFor('s1', [], `?ask=${TOKEN}`), { tag: 'ask:s1', askId: TOKEN, sessionId: 's1' })
  assert.equal(askFor('s1', [pending('s2', TOKEN)], ''), undefined)
})

test('a pending kept WITHOUT its token (this is the daemon machine) is still an ask, just not answerable here', () => {
  const ask = askFor('s1', [pending('s1')], '')
  assert.equal(ask?.askId, undefined)
  assert.equal(ask?.toolName, 'Write')
})
