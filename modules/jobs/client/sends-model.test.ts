import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SendView } from './contract.ts'
import type { SendKey } from './model.ts'
import {
  actionsOf,
  answerRefused,
  answerUnconfirmed,
  cardOf,
  expectOf,
  isSendRefusal,
  isStaleRefusal,
  staleRead,
  toRefresh,
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

test('an approve answered «failed» at once is tracked failed, with Retry, and read once for its `at`', () => {
  const sends = tracked([], key('a', 'Acme'), 'failed')
  assert.deepEqual(sends[0]?.line, { text: 'Acme: the send failed', tone: 'err', final: true, retry: true })
  assert.equal(isPolling(sends[0] as TrackedSend), true)
  assert.equal(isPolling(polled(sends, key('a'), { ...view('failed'), at: '2026-11-13T22:00:00.000Z' })[0] as TrackedSend), false)
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

// ── An answer whose response was lost is not a refusal (review finding 1) ────────────────────────

const failure = (status: number | undefined, body: unknown = undefined): Error => Object.assign(new Error(status === undefined ? 'boom' : `${status}`), { status, body })

test('only a 4xx with an error body is a refusal; a lost network, a timeout or a 5xx is not', () => {
  assert.equal(isSendRefusal(failure(409, { error: { code: 'conflict', message: 'stale' } })), true)
  assert.equal(isSendRefusal(failure(422, { error: { code: 'blocked', message: 'address-unverified' } })), true)
  assert.equal(isSendRefusal(failure(0)), false, 'no network: status 0')
  assert.equal(isSendRefusal(failure(undefined)), false, 'no status at all')
  assert.equal(isSendRefusal(failure(500, { error: { code: 'module-error', message: 'x' } })), false)
  assert.equal(isSendRefusal(failure(502)), false, 'the proxy, plain text')
  assert.equal(isSendRefusal(failure(404)), false, 'a 4xx with no error body is not the engine answering')
  assert.equal(isSendRefusal(new TypeError('Failed to fetch')), false)
  assert.equal(isSendRefusal('nope'), false)
})

test('an answer that could not be confirmed keeps polling, says so, and offers nothing to press', () => {
  const failed = polled(tracked([], key('a', 'Acme')), key('a'), view('failed'))
  const sends = answerUnconfirmed(failed, key('a'))
  assert.deepEqual(sends[0]?.line, { text: 'Acme: couldn’t confirm — checking…', tone: 'pending', final: false, retry: false })
  assert.equal(isPolling(sends[0] as TrackedSend), true, 'the email may be sending: read it again')
  assert.deepEqual(actions(sends[0]), [], 'never «Retry» while whether it went is unknown')
  const read = polled(sends, key('a'), view('sending'))
  assert.equal(read[0]?.line.text, 'Sending to Acme…')
  const unknown = answerUnconfirmed(polled(tracked([], key('b', 'Beta')), key('b'), view('send-unknown')), key('b'))
  assert.equal(polled(unknown, key('b'), view('sent'))[0]?.line.text, 'Sent to Beta ✓')
})

// ── The row the card showed travels with the answer (review finding 2) ───────────────────────────

const at = (state: SendView['state'], when: string): SendView => ({ kind: 'initial', state, at: when, reason: null })
const T1 = '2026-11-13T22:00:00.000Z'
const T2 = '2026-11-13T22:05:00.000Z'

test('each answer carries the state and the `at` the card showed; none while they are not known', () => {
  const unknown = polled(tracked([], key('a')), key('a'), at('send-unknown', T1))
  assert.deepEqual(expectOf(unknown[0] as TrackedSend), { state: 'send-unknown', at: T1 })
  const seededSend = seeded([], [{ applicationId: 'b', company: 'Beta', kind: 'initial', state: 'failed', at: T2, reason: null }])
  assert.deepEqual(expectOf(seededSend[0] as TrackedSend), { state: 'failed', at: T2 })
  assert.equal(expectOf(tracked([], key('c'))[0] as TrackedSend), null, '«Sending…» has no row read yet')
})

test('a row read with a new `at` and the same state is news: the card takes the new `at`', () => {
  const first = polled(tracked([], key('a')), key('a'), at('send-unknown', T1))
  const later = polled(first, key('a'), at('send-unknown', T2))
  assert.notEqual(later, first)
  assert.equal(later[0]?.at, T2)
})

test('a send tracked «failed» at once, its `at` not known, is read once to learn it, then stops', () => {
  const sends = tracked([], key('a', 'Acme'), 'failed')
  assert.equal(isPolling(sends[0] as TrackedSend), true)
  const read = polled(sends, key('a'), at('failed', T1))
  assert.equal(isPolling(read[0] as TrackedSend), false)
  assert.deepEqual(actions(read[0]), ['retry:Retry'])
})

test('a 409 stale is told apart from any other refusal', () => {
  const refusal = (status: number, message: string) => Object.assign(new Error(message), { status, body: { error: { code: 'conflict', message } } })
  assert.equal(isStaleRefusal(refusal(409, 'stale')), true)
  assert.equal(isStaleRefusal(refusal(409, 'check-pending')), false)
  assert.equal(isStaleRefusal(refusal(422, 'stale')), false)
})

test('a stale answer shows the row as it is now, says it changed, and offers what the new state offers', () => {
  const unknown = polled(tracked([], key('a', 'Acme')), key('a'), at('send-unknown', T1))
  const sends = staleRead(unknown, key('a'), at('failed', T2))
  assert.deepEqual(sends[0]?.line, { text: 'Acme: this send changed — check it again', tone: 'ask', final: true, retry: true })
  assert.deepEqual(expectOf(sends[0] as TrackedSend), { state: 'failed', at: T2 })
  assert.deepEqual(actions(sends[0]), ['retry:Retry'])
  const moving = staleRead(unknown, key('a'), at('sending', T2))
  assert.equal(isPolling(moving[0] as TrackedSend), true, 'another device sent it again: follow it')
})

test('«Send again» and «It didn’t go» ask for a second click; «It went» and «Retry» do not', () => {
  const unknown = polled(tracked([], key('a')), key('a'), at('send-unknown', T1))
  assert.deepEqual(
    actionsOf(unknown[0] as TrackedSend).map((a) => [a.action, a.confirm]),
    [
      ['went', null],
      ['again', 'Click again to send again'],
      ['not-went', 'Click again: it didn’t go'],
    ],
  )
  const failed = polled(tracked([], key('b')), key('b'), at('failed', T1))
  assert.equal(actionsOf(failed[0] as TrackedSend)[0]?.confirm, null)
})

test('a confirm armed on a card is gone once the card shows another row', () => {
  const unknown = polled(tracked([], key('a')), key('a'), at('send-unknown', T1))[0] as TrackedSend
  const moved = polled([unknown], key('a'), at('send-unknown', T2))[0] as TrackedSend
  assert.equal(cardOf(unknown), cardOf(unknown))
  assert.notEqual(cardOf(unknown), cardOf(moved))
})

test('on coming back to the screen, the lines that wait for the owner are read again; pending ones already are, ok ones need nothing', () => {
  let sends: readonly TrackedSend[] = []
  sends = polled(tracked(sends, key('u')), key('u'), at('send-unknown', T1))
  sends = polled(tracked(sends, key('f')), key('f'), at('failed', T1))
  sends = polled(tracked(sends, key('ok')), key('ok'), at('sent', T1))
  sends = tracked(sends, key('p'))
  let lost = tracked([], key('l'))
  for (let n = 0; n < MAX_POLL_FAILURES; n += 1) lost = pollFailed(lost, key('l'))
  assert.deepEqual(ids(toRefresh([...sends, ...lost])), ['u', 'f', 'l'])
})
