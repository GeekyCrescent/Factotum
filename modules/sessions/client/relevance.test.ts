import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionState, SessionSummary } from '../types.ts'
import type { HostView } from './contract.ts'
import { askFor, firstWithSession, grantOf, hostOf, landingReady, onHost, otherHosts, pickRelevant, questionsFor, questionsOf, resolvedBy, withLogBatches, type Pending } from './relevance.ts'

const TOKEN = 'a'.repeat(43)

const session = (id: string, state: SessionState, startedAt: string, touchedAt = startedAt): SessionSummary => ({
  id,
  siteId: 'demo',
  entryId: 'free',
  state,
  startedAt,
  touchedAt,
  endedAt: undefined,
  reason: undefined,
  turns: 1,
  prompt: undefined,
  agent: undefined,
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

test('"the most recent" IS THE LAST INTERACTION: the one started first but written into last', () => {
  // The same key the drawer is ordered by, so landing lands on its first row.
  const page = [session('started-last', 'finished', NEW), session('written-into-last', 'finished', OLD, NEWER)]
  assert.deepEqual(pickRelevant([], page), { kind: 'session', id: 'written-into-last' })
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

test('a batch open in the LOG is a batch to answer even with no pending and no URL: from the screen, without a token (2026-10-02)', () => {
  const refs = withLogBatches('s1', [], [{ id: BATCH, count: 2 }])
  assert.deepEqual(refs, [{ tag: `questions:s1:${BATCH}`, sessionId: 's1', batch: BATCH, count: 2 }])
})

test('withLogBatches adds only what the pendings and the URL do not already have, and keeps their tokens', () => {
  const known = questionsFor('s1', [questionsPending('s1', BATCH, { questionsId: TOKEN })], '')
  const refs = withLogBatches('s1', known, [{ id: BATCH, count: 3 }, { id: OTHER, count: 1 }])
  assert.deepEqual(refs.map((r) => [r.batch, r.token]), [
    [BATCH, TOKEN],
    [OTHER, undefined],
  ])
})

// ---------------------------------------------------------------------------
// Two hosts (spec 2026-10-07-dos-hosts, design D12; criteria 10, 14)
// ---------------------------------------------------------------------------

const LINUX: HostView = { name: 'omarchy', self: true, reachable: true, lastSeenAt: null }
const MAC: HostView = { name: 'mac', self: false, reachable: true, lastSeenAt: '2026-10-08T10:00:00.000Z' }
const MAC_DOWN: HostView = { ...MAC, reachable: false }
/** A pending the relay brought from the Mac: `data.host` is its name (design D6). */
const fromMac = (sessionId: string): Pending => ({ ...pending(sessionId), data: { ...pending(sessionId).data, host: 'mac' } })

test('hostOf: the name the relay put in data.host; none (or not a name) is the serving host', () => {
  assert.equal(hostOf(fromMac('m1')), 'mac')
  assert.equal(hostOf(pending('l1')), undefined)
  assert.equal(hostOf({ ...pending('l1'), data: { sessionId: 'l1', host: '' } }), undefined)
  assert.equal(hostOf({ ...pending('l1'), data: { sessionId: 'l1', host: 7 } }), undefined)
})

test('onHost: each host gets its own pendings; the serving host’s own name counts as the serving host', () => {
  const linux = pending('l1')
  const mac = fromMac('m1')
  const named: Pending = { ...pending('l2'), data: { sessionId: 'l2', host: 'omarchy' } }
  assert.deepEqual(onHost([linux, mac, named], [LINUX, MAC], undefined), [linux, named])
  assert.deepEqual(onHost([linux, mac, named], [LINUX, MAC], 'mac'), [mac])
})

test('one pending of each host: landing goes to the first, WITH its host (criterion 14)', () => {
  const page = [session('l1', 'running', NEW)]
  assert.deepEqual(pickRelevant([fromMac('m1'), pending('l1')], page, [LINUX, MAC]), { kind: 'session', id: 'm1', host: 'mac' })
  assert.deepEqual(pickRelevant([pending('l1'), fromMac('m1')], page, [LINUX, MAC]), { kind: 'session', id: 'l1' })
})

test('WITH THE MAC DOWN, landing on the Linux skips the Mac’s pending and lands on its own (criterion 10)', () => {
  const page = [session('l1', 'finished', NEW)]
  assert.deepEqual(pickRelevant([fromMac('m1')], page, [LINUX, MAC_DOWN]), { kind: 'session', id: 'l1' })
  assert.deepEqual(pickRelevant([fromMac('m1')], [], [LINUX, MAC_DOWN]), { kind: 'new' })
})

test('landing on another host’s screen: a session of its page stays on that host', () => {
  const macPage = [session('m2', 'running', NEW)]
  assert.deepEqual(pickRelevant([], macPage, [LINUX, MAC], 'mac'), { kind: 'session', id: 'm2', host: 'mac' })
  // Its pending of the serving host goes home: no host.
  assert.deepEqual(pickRelevant([pending('l1')], macPage, [LINUX, MAC], 'mac'), { kind: 'session', id: 'l1' })
})

test('resolvedBy per host: a pending is resolved only by the sessions of ITS host (criterion 14)', () => {
  const linuxPage = [session('x', 'finished', NEW)]
  const macPage = [session('m1', 'finished', NEW), session('x', 'running', NEW)]
  const all = [pending('x'), fromMac('m1'), fromMac('x')]
  assert.deepEqual(resolvedBy(all, linuxPage, [LINUX, MAC]), ['ask:x'])
  assert.deepEqual(resolvedBy(all, macPage, [LINUX, MAC], 'mac'), ['ask:m1'])
})

test('otherHosts: the hosts besides this screen’s with a pending to check, never one that is down (criterion 10)', () => {
  assert.deepEqual(otherHosts([pending('l1'), fromMac('m1'), fromMac('m2')], [LINUX, MAC], undefined), ['mac'])
  assert.deepEqual(otherHosts([fromMac('m1')], [LINUX, MAC_DOWN], undefined), [])
  assert.deepEqual(otherHosts([pending('l1'), fromMac('m1')], [LINUX, MAC], 'mac'), [undefined])
  assert.deepEqual(otherHosts([pending('l1')], [], undefined), [])
})

test('landingReady waits for GET /hosts only when a pending names a host', () => {
  assert.equal(landingReady([pending('l1')], []), true)
  assert.equal(landingReady([fromMac('m1')], []), false)
  assert.equal(landingReady([fromMac('m1')], [LINUX, MAC]), true)
})
