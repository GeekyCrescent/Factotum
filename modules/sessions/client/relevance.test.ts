import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionState, SessionSummary } from '../types.ts'
import { askFor, firstWithSession, grantOf, pickRelevant, questionsFor, questionsOf, resolvedBy, type Pending } from './relevance.ts'

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
  title: undefined,
  autoTitle: undefined,
  archived: false,
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

// ---------------------------------------------------------------------------
// folder requests (spec 2026-09-29, criterion 22)
// ---------------------------------------------------------------------------

const grantPending = (data: Record<string, unknown>): Pending => ({ tag: 'grant:req-1', until: '2099-01-01T00:00:00.000Z', data })

test('a folder request is read from its pending, with or without the token', () => {
  assert.deepEqual(grantOf(grantPending({ kind: 'grant', requestId: 'req-1', grantId: TOKEN, name: 'web' })), {
    tag: 'grant:req-1',
    requestId: 'req-1',
    grantId: TOKEN,
    name: 'web',
  })
  assert.deepEqual(grantOf(grantPending({ kind: 'grant', requestId: 'req-1' })), { tag: 'grant:req-1', requestId: 'req-1', name: undefined })
  assert.equal(grantOf(grantPending({ sessionId: 'x', askId: TOKEN })), undefined)
})

test('A FOLDER REQUEST DOES NOT HIDE AN ASK: the strip takes the first pending with a session, and landing skips it (criterion 22)', () => {
  const grant = grantPending({ kind: 'grant', requestId: 'req-1', name: 'web' })
  const ask: Pending = { tag: 'ask:s1', until: '2099-01-01T00:00:00.000Z', data: { sessionId: 's1' } }
  assert.equal(firstWithSession([grant, ask]), ask)
  assert.equal(firstWithSession([grant]), undefined)
  assert.deepEqual(pickRelevant([grant, ask], []), { kind: 'session', id: 's1' })
  assert.deepEqual(resolvedBy([grant], []), [])
})

// ---------------------------------------------------------------------------
// Questions (spec 2026-10-01-preguntas-con-opciones, D10; criteria 32, 40)
// ---------------------------------------------------------------------------

const BATCH = 'b'.repeat(32)
const OTHER = 'c'.repeat(32)
const TOKEN2 = 'z'.repeat(43)
const questionsPending = (sessionId: string, batch: string, extra: Record<string, unknown> = {}, until = '2099-01-01T00:00:00.000Z'): Pending => ({
  tag: `questions:${sessionId}:${batch}`,
  until,
  data: { kind: 'questions', batch, sessionId, siteId: 'demo', count: 3, ...extra },
})

test('a questions pending is read with its session, batch, count and token if any; an ask or a grant is not one (criterion 32)', () => {
  assert.deepEqual(questionsOf(questionsPending('s1', BATCH, { questionsId: TOKEN })), {
    tag: `questions:s1:${BATCH}`,
    sessionId: 's1',
    batch: BATCH,
    count: 3,
    token: TOKEN,
  })
  const kept = questionsOf(questionsPending('s1', BATCH))
  assert.equal(kept !== undefined && 'token' in kept, false)
  assert.equal(questionsOf(pending('s1', TOKEN)), undefined)
  assert.equal(questionsOf(grantPending({ kind: 'grant', requestId: 'r' })), undefined)
})

test('askFor SKIPS a questions pending: alone it gives no ask; with an ask of the same session, the ask (criterion 32)', () => {
  assert.equal(askFor('s1', [questionsPending('s1', BATCH)], ''), undefined)
  const both = askFor('s1', [questionsPending('s1', BATCH), pending('s1', TOKEN)], '')
  assert.equal(both?.tag, 'ask:s1')
  assert.equal(both?.askId, TOKEN)
})

test('questionsFor (1): a pending without token and the URL of its batch → that batch WITH the URL’s token (criterion 40)', () => {
  const refs = questionsFor('s1', [questionsPending('s1', BATCH)], `?questions=${TOKEN}&batch=${BATCH}`)
  assert.equal(refs.length, 1)
  assert.equal(refs[0]?.token, TOKEN)
  assert.equal(refs[0]?.count, 3)
})

test('questionsFor (2): no pending and a URL → the URL’s batch on its own (criterion 40)', () => {
  const refs = questionsFor('s1', [], `?questions=${TOKEN}&batch=${BATCH}`)
  assert.deepEqual(refs, [{ tag: `questions:s1:${BATCH}`, sessionId: 's1', batch: BATCH, count: undefined, token: TOKEN }])
})

test('questionsFor (3): a pending without token and no URL → no token: answer from the notification (criterion 40)', () => {
  const refs = questionsFor('s1', [questionsPending('s1', BATCH)], '')
  assert.equal(refs.length, 1)
  assert.equal(refs[0] !== undefined && 'token' in refs[0], false)
})

test('questionsFor (4): a pending WITH its token and the URL of another batch → both, each with its own (criterion 40)', () => {
  const refs = questionsFor('s1', [questionsPending('s1', BATCH, { questionsId: TOKEN2 })], `?questions=${TOKEN}&batch=${OTHER}`)
  assert.deepEqual(
    refs.map((r) => [r.batch, r.token]),
    [
      [BATCH, TOKEN2],
      [OTHER, TOKEN],
    ],
  )
})

test('questionsFor keeps only this session’s batches, the soonest deadline first, and ignores asks', () => {
  const refs = questionsFor(
    's1',
    [
      questionsPending('s1', OTHER, {}, '2099-01-02T00:00:00.000Z'),
      questionsPending('s2', BATCH),
      pending('s1', TOKEN),
      questionsPending('s1', BATCH, {}, '2099-01-01T00:00:00.000Z'),
    ],
    '',
  )
  assert.deepEqual(refs.map((r) => r.batch), [BATCH, OTHER])
})

test('a malformed questions URL is no batch', () => {
  assert.deepEqual(questionsFor('s1', [], `?questions=short&batch=${BATCH}`), [])
  assert.deepEqual(questionsFor('s1', [], `?questions=${TOKEN}&batch=nothex`), [])
})
