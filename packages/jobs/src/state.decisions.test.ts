/**
 * design D3 — the tests that pin the DECISIONS of the table (tasks B5, «Además, los que fijan las
 * decisiones»), across rows and entities.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addressTransition, appTransition, approvalGate, followupTransition, matchSend, sendTransition, type AppEvent } from './state.ts'
import { ADDRESSES, application, CAP, contact, errorOf, followup, NOW, send, valueOf } from './test-state.ts'
import type { Address, Application } from './types.ts'

const move = (app: Application, event: AppEvent): Application => valueOf(appTransition(app, event, NOW))
const approveWith = (address: Address | null, sendAnyway: boolean): AppEvent => ({
  type: 'approve',
  pdfExists: true,
  address,
  sendAnyway,
  cap: CAP,
  messageId: '<new@jobs.factotum.local>',
  profileVersion: 1,
})
const FIRST = '<first@jobs.factotum.local>'
const SECOND = '<second@jobs.factotum.local>'

// ── Without a CV there is no ready ───────────────────────────────────────────────────────────────

test('no CV, no ready: draft never goes to in-review or ready', () => {
  const draft = application({ state: 'draft', version: 0 })
  errorOf(appTransition(draft, { type: 'relint', pdfExists: true, warnings: [] }, NOW), 'conflict')
  errorOf(appTransition(draft, { type: 'generation-returned', pending: false, failed: [], pdfExists: true, warnings: [], version: 1 }, NOW), 'conflict')
})

test('no CV, no ready: generating → ready only with the PDF printed and nothing pending', () => {
  const generating = application({ state: 'generating' })
  errorOf(appTransition(generating, { type: 'generation-returned', pending: true, failed: [], pdfExists: true, warnings: [], version: 1 }, NOW), 'conflict', 'requests-pending')
  const noPdf = move(generating, { type: 'generation-returned', pending: false, failed: [], pdfExists: false, warnings: [], version: 1 })
  assert.equal(noPdf.state, 'in-review')
  assert.equal(move(application({ state: 'in-review' }), { type: 'relint', pdfExists: false, warnings: [] }).state, 'in-review')
})

// ── Approve by channel ───────────────────────────────────────────────────────────────────────────

test('approve by channel: an email never stores approved, and approved → sending does not exist', () => {
  assert.equal(move(application(), approveWith(ADDRESSES.verifiedToday, false)).state, 'sending')
  const manual = move(application({ channel: 'linkedin' }), approveWith(null, false))
  assert.equal(manual.state, 'approved')
  errorOf(appTransition(manual, approveWith(ADDRESSES.verifiedToday, false), NOW), 'conflict')
  assert.equal(move(manual, { type: 'mark-sent' }).state, 'sent')
})

test('approve by channel: a failure before DATA puts the email back in ready (T-A15)', () => {
  const sending = move(application(), approveWith(ADDRESSES.verifiedToday, false))
  assert.equal(move(sending, { type: 'smtp-failed', reason: 'timeout' }).state, 'ready')
})

// ── The address (A2) and «Qué responde el motor» (v5, X4): one test per fixture and button ─────

const table: readonly {
  readonly fixture: keyof typeof ADDRESSES
  readonly approve: 'pass' | 'check-pending' | 'address-unverified'
  readonly sendAnyway: 'pass' | 'check-pending'
}[] = [
  { fixture: 'verifiedToday', approve: 'pass', sendAnyway: 'pass' },
  { fixture: 'verifiedStale', approve: 'check-pending', sendAnyway: 'check-pending' },
  { fixture: 'checking', approve: 'check-pending', sendAnyway: 'check-pending' },
  { fixture: 'unverifiedNeverChecked', approve: 'check-pending', sendAnyway: 'check-pending' },
  { fixture: 'unverifiedToday', approve: 'address-unverified', sendAnyway: 'pass' },
  { fixture: 'unverifiedTodayOverride', approve: 'pass', sendAnyway: 'pass' },
  { fixture: 'unverifiedStaleOverride', approve: 'check-pending', sendAnyway: 'check-pending' },
]

for (const row of table) {
  for (const [button, sendAnyway, expected] of [
    ['Approve', false, row.approve],
    ['Send anyway', true, row.sendAnyway],
  ] as const) {
    test(`the engine on ${row.fixture}, «${button}»: ${expected}`, () => {
      const address = ADDRESSES[row.fixture]
      const result = appTransition(application(), approveWith(address, sendAnyway), NOW)
      if (expected === 'pass') {
        assert.equal(valueOf(result).state, 'sending')
        return
      }
      errorOf(result, expected === 'check-pending' ? 'conflict' : 'blocked', expected)
      // The same table for a follow-up (T-F6).
      const fu = followupTransition(followup(), { type: 'approve', app: { state: 'sent', hasHumanReply: false }, address, sendAnyway, cap: CAP }, NOW)
      errorOf(fu, expected === 'check-pending' ? 'conflict' : 'blocked', expected)
    })
  }
}

test('«Send anyway» on an address checked today writes the override (T-D5) and marks the send', () => {
  const gate = valueOf(approvalGate(ADDRESSES.unverifiedToday, NOW, true))
  assert.equal(gate.override, 'new')
  const next = move(application(), approveWith(ADDRESSES.unverifiedToday, true))
  assert.equal(next.sends[0]?.addressOverride, true)
  const withOverride = valueOf(addressTransition(contact(ADDRESSES.unverifiedToday), { type: 'send-anyway' }, NOW))
  assert.deepEqual(withOverride.address?.override, { at: NOW.toISOString() })
})

test('a contact\'s override serves the follow-up to the same address (A2)', () => {
  const fu = valueOf(
    followupTransition(followup(), { type: 'approve', app: { state: 'sent', hasHumanReply: false }, address: ADDRESSES.unverifiedTodayOverride, sendAnyway: false, cap: CAP }, NOW),
  )
  assert.equal(fu.state, 'sending')
  assert.equal(valueOf(approvalGate(ADDRESSES.unverifiedTodayOverride, NOW, false)).override, 'existing')
})

test('the address does not count for review: a clean email is ready with the address in any state', () => {
  for (const address of [ADDRESSES.checking, ADDRESSES.verifiedToday, ADDRESSES.unverifiedNeverChecked]) {
    void address // the re-lint takes no address: it is a guard of approving, never a warning (A2)
    assert.equal(move(application({ state: 'in-review' }), { type: 'relint', pdfExists: true, warnings: [] }).state, 'ready')
  }
})

test('an email without an address is blocked, never sent', () => {
  errorOf(appTransition(application(), approveWith(null, false), NOW), 'blocked', 'no-address')
})

// ── Follow-ups (A3) ──────────────────────────────────────────────────────────────────────────────

test('follow-up: failed → sending by «Retry» (T-F10), never back to ready', () => {
  const next = valueOf(followupTransition(followup({ state: 'failed' }), { type: 'retry', cap: CAP }, NOW))
  assert.equal(next.state, 'sending')
})

test('follow-up: T-F11 cancels from draft, ready, rewriting and failed, never from sending, send-unknown or sent', () => {
  for (const state of ['draft', 'ready', 'rewriting', 'failed'] as const) {
    assert.equal(valueOf(followupTransition(followup({ state }), { type: 'cancel', why: 'replied' }, NOW)).state, 'cancelled')
  }
  for (const state of ['sending', 'send-unknown', 'sent'] as const) {
    errorOf(followupTransition(followup({ state }), { type: 'cancel', why: 'replied' }, NOW), 'conflict')
  }
})

test('follow-up send-unknown with the application replied or closed (v5, X9)', () => {
  for (const appState of ['replied', 'closed'] as const) {
    const app = { state: appState, hasHumanReply: true }
    const unknown = followup({ state: 'send-unknown' })
    assert.equal(valueOf(followupTransition(unknown, { type: 'it-went' }, NOW)).state, 'sent')
    assert.equal(valueOf(followupTransition(unknown, { type: 'it-didnt-go', app }, NOW)).state, 'cancelled')
    const row = valueOf(sendTransition(send({ kind: 'followup-1', followupId: 'fu-1', state: 'send-unknown' }), { type: 'it-didnt-go', appState }, NOW))
    assert.deepEqual([row.state, row.reason], ['failed', 'owner-not-sent'])
    errorOf(followupTransition(unknown, { type: 'send-again', app, cap: CAP }, NOW), 'conflict')
  }
  errorOf(followupTransition(followup({ state: 'send-unknown' }), { type: 'it-didnt-go', app: { state: 'sent', hasHumanReply: false } }, NOW), 'conflict')
  errorOf(sendTransition(send({ kind: 'followup-1', state: 'send-unknown' }), { type: 'it-didnt-go', appState: 'sent' }, NOW), 'conflict')
})

// ── A reply to a send-unknown (A7), and to a failed (v6, M3) ────────────────────────────────────

test('a reply quoting the FIRST attempt of a retried initial proves it: sent, viaAttempt (v6.1)', () => {
  // initial failed → «Retry» (T-S8) → cut after DATA (T-S4) → the reply quotes the first messageId.
  const failed = application({ state: 'ready', sends: [send({ state: 'failed', messageId: FIRST, reason: 'timeout' })] })
  const retried = move(failed, { ...approveWith(ADDRESSES.verifiedToday, false), messageId: SECOND } as AppEvent)
  assert.deepEqual(retried.sends[0]?.attempts.map((a) => a.messageId), [FIRST])
  const unknown = move(retried, { type: 'smtp-unknown' })
  assert.deepEqual(matchSend(unknown.sends, FIRST), { send: unknown.sends[0], viaAttempt: true })
  const interview = move(unknown, { type: 'reply', replyClass: 'interview', rule: 1, messageId: FIRST })
  assert.deepEqual([interview.state, interview.outcome, interview.sends[0]?.state], ['replied', 'interview', 'sent'])
  const ack = move(unknown, { type: 'reply', replyClass: 'auto-ack', rule: 1, messageId: FIRST })
  assert.deepEqual([ack.state, ack.sends[0]?.state], ['sent', 'sent'])
})

test('rules 2–3 only prove the initial: a send-unknown follow-up row is not touched by them', () => {
  const app = application({
    state: 'sent',
    sends: [send({ state: 'sent' }), send({ kind: 'followup-1', followupId: 'fu-1', messageId: SECOND, state: 'send-unknown' })],
  })
  const next = move(app, { type: 'reply', replyClass: 'auto-ack', rule: 2, messageId: null })
  assert.equal(next.sends[1]?.state, 'send-unknown')
  const byRule1 = move(app, { type: 'reply', replyClass: 'auto-ack', rule: 1, messageId: SECOND })
  assert.equal(byRule1.sends[1]?.state, 'sent')
})

test('a failed initial is proved only by rule 1 (T-S11)', () => {
  const app = application({ state: 'ready', sends: [send({ state: 'failed' })] })
  errorOf(appTransition(app, { type: 'reply', replyClass: 'interview', rule: 2, messageId: null }, NOW), 'conflict')
  errorOf(sendTransition(send({ state: 'failed' }), { type: 'reply', rule: 2, messageId: null }, NOW), 'conflict')
})

test('T-A30 from approved: failed email, «Switch to form», approved, then the reply leaves it sent (v6.1)', () => {
  const failed = application({ state: 'ready', sends: [send({ state: 'failed', messageId: FIRST })] })
  const form = move(failed, { type: 'switch-to-form', url: 'https://acme.example/careers' })
  const approved = move(form, approveWith(null, false))
  assert.equal(approved.state, 'approved')
  const next = move(approved, { type: 'reply', replyClass: 'auto-ack', rule: 1, messageId: FIRST })
  assert.deepEqual([next.state, next.channel, next.sends.length], ['sent', 'form', 1])
})

test('a reply on a failed initial of a closed application: sent row, then its class (T-S11, T-A24)', () => {
  const app = application({ state: 'closed', outcome: 'dropped', sends: [send({ state: 'failed' })] })
  const next = move(app, { type: 'reply', replyClass: 'interview', rule: 1, messageId: '<m1@jobs.factotum.local>' })
  assert.deepEqual([next.state, next.outcome, next.sends[0]?.state], ['replied', 'interview', 'sent'])
})

test('a reply that matches no send by rule 1 is a conflict (D12 does not hand it over)', () => {
  errorOf(appTransition(application({ state: 'sent', sends: [send({ state: 'sent' })] }), { type: 'reply', replyClass: 'interview', rule: 1, messageId: '<other@x>' }, NOW), 'conflict')
  errorOf(appTransition(application({ state: 'ready' }), { type: 'reply', replyClass: 'interview', rule: 2, messageId: null }, NOW), 'conflict')
})

// ── A reply with the initial in sending (v6.1): deferred, then applied at the close ──────────────

test('a reply while the initial is sending is deferred: nothing changes, no conflict', () => {
  const sending = application({ state: 'sending', sends: [send({ state: 'sending' })] })
  assert.deepEqual(move(sending, { type: 'reply', replyClass: 'interview', rule: 1, messageId: '<m1@jobs.factotum.local>' }), sending)
})

test('deferred, then SMTP accepts (T-S2): sent and its class row', () => {
  const sending = application({ state: 'sending', sends: [send({ state: 'sending' })] })
  const sent = move(sending, { type: 'smtp-accepted', response: '250 OK' })
  const next = move(sent, { type: 'reply', replyClass: 'interview', rule: 1, messageId: '<m1@jobs.factotum.local>' })
  assert.deepEqual([next.state, next.outcome], ['replied', 'interview'])
})

test('deferred, then a failure before DATA (T-S3): T-S11 + T-A30, never back to ready', () => {
  const sending = application({ state: 'sending', sends: [send({ state: 'sending', messageId: SECOND, attempts: [{ messageId: FIRST, at: '2026-11-12T00:00:00.000Z', reason: 'x' }] })] })
  const failed = move(sending, { type: 'smtp-failed', reason: 'timeout' })
  const next = move(failed, { type: 'reply', replyClass: 'auto-ack', rule: 1, messageId: FIRST })
  assert.deepEqual([next.state, next.sends[0]?.state], ['sent', 'sent'])
})

test('deferred, then a cut after DATA or a restart (T-S4): T-S7 + T-A17, no «did it go?»', () => {
  const sending = application({ state: 'sending', sends: [send({ state: 'sending' })] })
  const unknown = move(sending, { type: 'smtp-unknown' })
  const next = move(unknown, { type: 'reply', replyClass: 'rejection', rule: 1, messageId: '<m1@jobs.factotum.local>' })
  assert.deepEqual([next.state, next.outcome, next.sends[0]?.state], ['closed', 'rejected', 'sent'])
})

// ── Send.state ───────────────────────────────────────────────────────────────────────────────────

test('«Retry» updates the same row: a new messageId, the old one in attempts, reason cleared (T-S8)', () => {
  const failed = send({ state: 'failed', messageId: FIRST, reason: 'timeout', at: '2026-11-12T00:00:00.000Z' })
  const next = valueOf(sendTransition(failed, { type: 'retry', messageId: SECOND, cap: CAP, addressOverride: false, profileVersion: 2, artifactsVersion: 1 }, NOW))
  assert.deepEqual([next.kind, next.state, next.messageId, next.reason], ['initial', 'sending', SECOND, null])
  assert.deepEqual(next.attempts, [{ messageId: FIRST, at: '2026-11-12T00:00:00.000Z', reason: 'timeout' }])
})

test('T-A11 over a failed initial is T-S8 whether «Retry» or «Approve» of the batch (v6, M1)', () => {
  const app = application({ state: 'ready', sends: [send({ state: 'failed', messageId: FIRST })] })
  const next = move(app, { ...approveWith(ADDRESSES.verifiedToday, false), messageId: SECOND } as AppEvent)
  assert.equal(next.sends.length, 1)
  assert.deepEqual([next.sends[0]?.messageId, next.sends[0]?.attempts[0]?.messageId], [SECOND, FIRST])
  const sent = application({ state: 'ready', sends: [send({ state: 'sent' })] })
  errorOf(appTransition(sent, approveWith(ADDRESSES.verifiedToday, false), NOW), 'conflict')
})

test('«It didn\'t go» of the initial: failed and ready, never a faked sent (v6, M2)', () => {
  const unknown = application({ state: 'send-unknown', sends: [send({ state: 'send-unknown' })] })
  const next = move(unknown, { type: 'it-didnt-go' })
  assert.deepEqual([next.state, next.sends[0]?.state], ['ready', 'failed'])
})

test('the daily cap is a limit, not a conflict', () => {
  errorOf(appTransition(application(), { ...approveWith(ADDRESSES.verifiedToday, false), cap: { sentToday: 40, maxPerDay: 40 } } as AppEvent, NOW), 'limit')
})

// ── The owner's exits (v5, X3) ──────────────────────────────────────────────────────────────────

test('«Close» from sending or send-unknown is a conflict: the send is resolved first', () => {
  errorOf(appTransition(application({ state: 'sending', sends: [send()] }), { type: 'close', reason: 'x' }, NOW), 'conflict')
  errorOf(appTransition(application({ state: 'send-unknown', sends: [send({ state: 'send-unknown' })] }), { type: 'close', reason: 'x' }, NOW), 'conflict')
})

test('«Skip → not a fit» of a ready follow-up: follow-up cancelled and application closed together (T-F12)', () => {
  const fu = valueOf(followupTransition(followup({ state: 'ready' }), { type: 'skip-not-a-fit' }, NOW))
  const app = move(application({ state: 'sent', sends: [send({ state: 'sent' })] }), { type: 'close', reason: 'not-a-fit', outcome: 'dropped' })
  assert.deepEqual([fu.state, app.state, app.outcome], ['cancelled', 'closed', 'dropped'])
})

// ── Replies on replied/closed never conflict; only a human reply changes state ─────────────────

test('no matched reply gives a conflict from send-unknown, sent, replied or closed, for any class', () => {
  const classes = ['interview', 'asks-something', 'offer', 'rejection', 'auto-ack', 'other', 'unrelated'] as const
  for (const from of ['send-unknown', 'sent', 'replied', 'closed'] as const) {
    for (const replyClass of classes) {
      const app = application({ state: from, sends: [send({ state: from === 'send-unknown' ? 'send-unknown' : 'sent' })] })
      assert.ok(appTransition(app, { type: 'reply', replyClass, rule: 1, messageId: '<m1@jobs.factotum.local>' }, NOW).ok, `${from} ${replyClass}`)
      assert.ok(appTransition(app, { type: 'reply', replyClass, rule: 3, messageId: null }, NOW).ok, `${from} ${replyClass} rule 3`)
    }
  }
})

test('from send-unknown, a non-human reply is T-A17 (sent) then T-A29 (no other change)', () => {
  const app = application({ state: 'send-unknown', sends: [send({ state: 'send-unknown' })] })
  for (const replyClass of ['auto-ack', 'other', 'unrelated'] as const) {
    const next = move(app, { type: 'reply', replyClass, rule: 1, messageId: '<m1@jobs.factotum.local>' })
    assert.deepEqual([next.state, next.outcome], ['sent', null])
  }
})

// ── The address after a restart, and stale (v5, X2) ────────────────────────────────────────────

test('T-D6 leaves checking unverified with checkedAt null and the override intact', () => {
  const checking: Address = { ...ADDRESSES.checking, checkedAt: '2026-11-01T00:00:00.000Z', override: { at: '2026-11-01T00:00:00.000Z' } }
  const next = valueOf(addressTransition(contact(checking), { type: 'restart' }, NOW))
  assert.deepEqual(next.address, { status: 'unverified', verifiedUrl: null, checkedAt: null, override: { at: '2026-11-01T00:00:00.000Z' } })
})

test('T-D2 from verified only when the check is older than ADDRESS_STALE_DAYS', () => {
  errorOf(addressTransition(contact(ADDRESSES.verifiedToday), { type: 'enqueue-check' }, NOW), 'conflict')
  assert.equal(valueOf(addressTransition(contact(ADDRESSES.verifiedStale), { type: 'enqueue-check' }, NOW)).address?.status, 'checking')
})
