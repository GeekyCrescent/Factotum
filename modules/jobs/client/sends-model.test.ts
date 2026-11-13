import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SendView } from './contract.ts'
import type { SendKey } from './model.ts'
import {
  actionsOf,
  answerRefused,
  kindLabel,
  MAX_LINES,
  MAX_POLL_FAILURES,
  dismissed,
  isPolling,
  pollFailed,
  polled,
  repolled,
  retryRefused,
  seeded,
  sendStateOf,
  tracked,
  type TrackedSend,
} from './sends-model.ts'

const key = (applicationId: string, company = applicationId): SendKey => ({ applicationId, kind: 'initial', company })
const view = (state: SendView['state'], reason: string | null = null): SendView => ({ kind: 'initial', state, at: '', reason })
const ids = (sends: readonly TrackedSend[]): readonly string[] => sends.map((send) => send.key.applicationId)

test('a tracked send starts «Sending…» and is polled', () => {
  const sends = tracked([], key('a', 'Acme'))
  assert.equal(sends.length, 1)
  assert.equal(sends[0]?.line.text, 'Sending to Acme…')
  assert.equal(isPolling(sends[0] as TrackedSend), true)
})

test('tracking the same send again replaces its line, it does not add one', () => {
  const once = tracked([], key('a'))
  const twice = tracked(once, key('a'))
  assert.deepEqual(ids(twice), ['a'])
})

test('an answer that changes nothing returns the same list, so nothing is drawn again', () => {
  const sends = tracked([], key('a'))
  assert.equal(polled(sends, key('a'), view('sending')), sends)
})

test('an answer moves the line on and stops its poll when final', () => {
  const sends = polled(tracked([], key('a', 'Acme')), key('a'), view('sent'))
  assert.equal(sends[0]?.line.text, 'Sent to Acme ✓')
  assert.equal(isPolling(sends[0] as TrackedSend), false)
})

test('an answer for a send no longer tracked changes nothing', () => {
  const sends = tracked([], key('a'))
  assert.equal(polled(sends, key('zz'), view('sent')), sends)
  assert.equal(pollFailed(sends, key('zz')), sends)
})

test('only final ok lines are evicted; a failed or unknown line stays until dismissed', () => {
  let sends: readonly TrackedSend[] = []
  sends = polled(tracked(sends, key('f')), key('f'), view('failed', '535 auth'))
  sends = polled(tracked(sends, key('u')), key('u'), view('send-unknown'))
  sends = tracked(sends, key('p'))
  sends = polled(tracked(sends, key('ok1')), key('ok1'), view('sent'))
  sends = tracked(sends, key('p2'))
  // Five lines: the ok one is the only one that may go.
  assert.deepEqual(ids(sends), ['f', 'u', 'p', 'p2'])
  assert.equal(sends.length > MAX_LINES, true)
  sends = dismissed(sends, key('f'))
  assert.deepEqual(ids(sends), ['u', 'p', 'p2'])
})

test('the oldest ok lines go first once the bar is full', () => {
  let sends: readonly TrackedSend[] = []
  for (const id of ['a', 'b', 'c']) sends = polled(tracked(sends, key(id)), key(id), view('sent'))
  sends = tracked(sends, key('d'))
  assert.deepEqual(ids(sends), ['b', 'c', 'd'])
})

test(`after ${MAX_POLL_FAILURES} failed reads in a row the line says «status unknown» and stops polling`, () => {
  let sends = tracked([], key('a', 'Acme'))
  for (let n = 1; n < MAX_POLL_FAILURES; n += 1) sends = pollFailed(sends, key('a'))
  assert.equal(isPolling(sends[0] as TrackedSend), true)
  assert.equal(sends[0]?.line.text, 'Sending to Acme…')
  sends = pollFailed(sends, key('a'))
  assert.equal(sends[0]?.line.text, 'Acme: status unknown — check the tracker')
  assert.equal(sends[0]?.lost, true)
  assert.equal(sends[0]?.line.retry, false, 'a lost read never offers to SEND again')
  assert.equal(isPolling(sends[0] as TrackedSend), false)
  const back = repolled(sends, key('a'))
  assert.equal(isPolling(back[0] as TrackedSend), true)
  assert.equal(back[0]?.failures, 0)
  assert.equal(back[0]?.lost, false)
})

test('a good read resets the failure count', () => {
  const sends = polled(pollFailed(tracked([], key('a')), key('a')), key('a'), view('sending'))
  assert.equal(sends[0]?.failures, 0)
})

test('a refused retry shows why and offers Retry again', () => {
  const sends = retryRefused(polled(tracked([], key('a', 'Acme')), key('a'), view('failed')), key('a'), 'smtp down')
  assert.deepEqual(sends[0]?.line, { text: 'Acme: smtp down', tone: 'err', final: true, retry: true })
})

test('the state a decision answered is read as a send state, or not at all', () => {
  assert.equal(sendStateOf('sending'), 'sending')
  assert.equal(sendStateOf('failed'), 'failed')
  assert.equal(sendStateOf('send-unknown'), 'send-unknown')
  assert.equal(sendStateOf('sent'), 'sent')
  assert.equal(sendStateOf('approved'), null)
  assert.equal(sendStateOf(undefined), null)
})

test('an approve answered «failed» at once is tracked failed, with Retry, and not polled', () => {
  const sends = tracked([], key('a', 'Acme'), 'failed')
  assert.deepEqual(sends[0]?.line, { text: 'Acme: the send failed', tone: 'err', final: true, retry: true })
  assert.equal(isPolling(sends[0] as TrackedSend), false)
  assert.equal(tracked([], key('a', 'Acme'), null)[0]?.line.text, 'Sending to Acme…')
})

// ── The send-unknown card per send (R5b; D9, v6 M2) ──────────────────────────────────────────────

const actions = (send: TrackedSend | undefined): readonly string[] => (send === undefined ? [] : actionsOf(send).map((a) => `${a.action}:${a.label}`))

test('an initial whose fate is unknown offers «It went», «Send again» and «It didn’t go»', () => {
  const sends = polled(tracked([], key('a')), key('a'), view('send-unknown'))
  assert.deepEqual(actions(sends[0]), ['went:It went', 'again:Send again', 'not-went:It didn’t go'])
})

test('a follow-up whose fate is unknown offers «It went» and «Send again», not «It didn’t go»', () => {
  const k: SendKey = { applicationId: 'a', kind: 'followup-1', company: 'Acme' }
  const sends = polled(tracked([], k), k, { kind: 'followup-1', state: 'send-unknown', at: '', reason: null })
  assert.deepEqual(actions(sends[0]), ['went:It went', 'again:Send again'])
})

test('a failed send offers Retry; a pending, sent or lost one offers nothing', () => {
  assert.deepEqual(actions(polled(tracked([], key('a')), key('a'), view('failed'))[0]), ['retry:Retry'])
  assert.deepEqual(actions(tracked([], key('a'))[0]), [])
  assert.deepEqual(actions(polled(tracked([], key('a')), key('a'), view('sent'))[0]), [])
  let lost = tracked([], key('a'))
  for (let n = 0; n < MAX_POLL_FAILURES; n += 1) lost = pollFailed(lost, key('a'))
  assert.deepEqual(actions(lost[0]), [], 'whether it went is exactly what is unknown')
})

test('a refused answer says why and keeps the same choices', () => {
  const unknown = polled(tracked([], key('a', 'Acme')), key('a'), view('send-unknown'))
  const sends = answerRefused(unknown, key('a'), 'conflict')
  assert.equal(sends[0]?.line.text, 'Acme: conflict')
  assert.equal(sends[0]?.line.tone, 'err')
  assert.deepEqual(actions(sends[0]), actions(unknown[0]))
})

test('the sends the tracker brings (overview) become cards with their reason; one already followed is left as it is', () => {
  const needs = [
    { applicationId: 'a', company: 'Acme', kind: 'initial' as const, state: 'failed' as const, at: '', reason: '535 auth' },
    { applicationId: 'b', company: 'Beta', kind: 'followup-1' as const, state: 'send-unknown' as const, at: '', reason: null },
  ]
  const sends = seeded([], needs)
  assert.deepEqual(
    sends.map((s) => [s.key.applicationId, s.line.text]),
    [
      ['a', 'Acme: 535 auth'],
      ['b', 'Beta: did it go?'],
    ],
  )
  assert.deepEqual(actions(sends[0]), ['retry:Retry'])
  const followed = tracked([], { applicationId: 'a', kind: 'initial', company: 'Acme' })
  assert.equal(seeded(followed, needs)[0]?.line.text, 'Sending to Acme…')
  assert.equal(seeded(sends, needs), sends, 'nothing new: the same list')
})

test('each send is named by its kind: «Initial email», «Follow-up 1»', () => {
  assert.equal(kindLabel('initial'), 'Initial email')
  assert.equal(kindLabel('followup-1'), 'Follow-up 1')
  assert.equal(kindLabel('followup-2'), 'Follow-up 2')
})
