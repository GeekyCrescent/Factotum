/**
 * design D3, the single transition table — the SEND (T-S1…T-S11), FOLLOW-UP (T-F1…T-F15) and
 * ADDRESS (T-D1…T-D7) rows, one test per row, and one invalid transition per state (tasks B5, v5 X3).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addressTransition, followupTransition, newFollowup, sendTransition, type AddressEvent, type FollowupEvent, type SendEvent } from './state.ts'
import { ADDRESSES, ADVISORY, BLOCKER, CAP, contact, errorOf, followup, followupVersion, NOW, send, TODAY, valueOf } from './test-state.ts'
import type { Contact, Followup, FollowupState, Send } from './types.ts'

const AT = NOW.toISOString()
const SENT_APP = { state: 'sent', hasHumanReply: false } as const
const s = (row: Send | null, event: SendEvent): Send => valueOf(sendTransition(row, event, NOW))
const f = (row: Followup, event: FollowupEvent): Followup => valueOf(followupTransition(row, event, NOW))
const d = (row: Contact, event: AddressEvent): Contact => valueOf(addressTransition(row, event, NOW))

// ── Send ─────────────────────────────────────────────────────────────────────────────────────────

test('T-S1: approving writes a new row in sending, with its messageId, before SMTP opens', () => {
  const row = s(null, { type: 'approve', kind: 'followup-1', followupId: 'fu-1', messageId: '<a@jobs.factotum.local>', addressOverride: true, profileVersion: 4 })
  assert.deepEqual(row, {
    kind: 'followup-1',
    followupId: 'fu-1',
    channel: 'smtp',
    messageId: '<a@jobs.factotum.local>',
    state: 'sending',
    at: AT,
    response: null,
    reason: null,
    addressOverride: true,
    profileVersion: 4,
    attempts: [],
  })
})

test('T-S2: SMTP accepted: sending → sent with the response', () => {
  const row = s(send(), { type: 'smtp-accepted', response: '250 2.0.0 OK' })
  assert.deepEqual([row.state, row.response, row.at], ['sent', '250 2.0.0 OK', AT])
})

test('T-S3: a 5xx or a failure before DATA: sending → failed with the masked reason', () => {
  const row = s(send(), { type: 'smtp-failed', reason: '535 auth failed' })
  assert.deepEqual([row.state, row.reason], ['failed', '535 auth failed'])
})

test('T-S4: a cut after DATA, or a restart: sending → send-unknown', () => {
  assert.equal(s(send(), { type: 'smtp-unknown' }).state, 'send-unknown')
})

test('T-S5: «It went»: send-unknown → sent', () => {
  assert.equal(s(send({ state: 'send-unknown' }), { type: 'it-went' }).state, 'sent')
})

test('T-S6: «Send again»: send-unknown → sending with the SAME messageId, within the daily cap', () => {
  const row = s(send({ state: 'send-unknown' }), { type: 'send-again', cap: CAP })
  assert.deepEqual([row.state, row.messageId], ['sending', '<m1@jobs.factotum.local>'])
  errorOf(sendTransition(send({ state: 'send-unknown' }), { type: 'send-again', cap: { sentToday: 3, maxPerDay: 3 } }, NOW), 'limit')
})

test('T-S7: a reply proves a send-unknown: by its messageId, one of its attempts, or rules 2–3 on the initial', () => {
  const unknown = send({ state: 'send-unknown', attempts: [{ messageId: '<old@x>', at: TODAY, reason: null }] })
  assert.equal(s(unknown, { type: 'reply', rule: 1, messageId: '<m1@jobs.factotum.local>' }).state, 'sent')
  assert.equal(s(unknown, { type: 'reply', rule: 1, messageId: '<old@x>' }).state, 'sent')
  assert.equal(s(unknown, { type: 'reply', rule: 3, messageId: null }).state, 'sent')
  errorOf(sendTransition(unknown, { type: 'reply', rule: 1, messageId: '<other@x>' }, NOW), 'conflict')
  errorOf(sendTransition({ ...unknown, kind: 'followup-1' }, { type: 'reply', rule: 2, messageId: null }, NOW), 'conflict')
})

test('T-S8: «Retry»: failed → sending on the same row, a new messageId, the old one in attempts', () => {
  const row = s(send({ state: 'failed', reason: 'boom' }), { type: 'retry', messageId: '<m2@x>', cap: CAP, addressOverride: true, profileVersion: 2 })
  assert.deepEqual([row.state, row.messageId, row.reason, row.addressOverride, row.profileVersion], ['sending', '<m2@x>', null, true, 2])
  assert.deepEqual(row.attempts, [{ messageId: '<m1@jobs.factotum.local>', at: '2026-11-10T00:00:00.000Z', reason: 'boom' }])
  errorOf(sendTransition(send({ state: 'failed' }), { type: 'retry', messageId: '<m2@x>', cap: { sentToday: 1, maxPerDay: 1 }, addressOverride: false, profileVersion: 1 }, NOW), 'limit')
})

test('T-S9: «Mark as sent» or imported by hand: a manual row, sent, without a messageId', () => {
  const row = s(null, { type: 'mark-sent', kind: 'initial', followupId: null })
  assert.deepEqual([row.channel, row.messageId, row.state, row.at], ['manual', null, 'sent', AT])
})

test('T-S10: «It didn\'t go» of an initial, or of a follow-up with the application replied/closed: failed', () => {
  const initial = s(send({ state: 'send-unknown' }), { type: 'it-didnt-go', appState: 'send-unknown' })
  assert.deepEqual([initial.state, initial.reason], ['failed', 'owner-not-sent'])
  const fu = s(send({ kind: 'followup-2', state: 'send-unknown' }), { type: 'it-didnt-go', appState: 'closed' })
  assert.equal(fu.state, 'failed')
})

test('T-S11: a reply proves a failed row, only by rule 1 (its messageId or an attempt): sent, reason cleared', () => {
  const failed = send({ state: 'failed', reason: 'boom', attempts: [{ messageId: '<old@x>', at: TODAY, reason: 'x' }] })
  assert.deepEqual([s(failed, { type: 'reply', rule: 1, messageId: '<m1@jobs.factotum.local>' }).state, s(failed, { type: 'reply', rule: 1, messageId: '<old@x>' }).reason], ['sent', null])
})

const invalidSends: readonly { readonly from: Send['state']; readonly name: string; readonly event: SendEvent }[] = [
  { from: 'sending', name: '«It went»', event: { type: 'it-went' } },
  { from: 'send-unknown', name: '«Retry» (T-S8 is only failed)', event: { type: 'retry', messageId: '<n@x>', cap: CAP, addressOverride: false, profileVersion: 1 } },
  { from: 'sent', name: '«Retry»', event: { type: 'retry', messageId: '<n@x>', cap: CAP, addressOverride: false, profileVersion: 1 } },
  { from: 'failed', name: '«It went»', event: { type: 'it-went' } },
]
for (const { from, name, event } of invalidSends) {
  test(`invalid send: ${name} from ${from} is a conflict`, () => errorOf(sendTransition(send({ state: from }), event, NOW), 'conflict'))
}

test('a send row is never created twice, and nothing but approve or mark-sent creates one', () => {
  errorOf(sendTransition(send(), { type: 'approve', kind: 'initial', followupId: null, messageId: '<x@x>', addressOverride: false, profileVersion: 1 }, NOW), 'conflict')
  errorOf(sendTransition(null, { type: 'it-went' }, NOW), 'conflict')
})

// ── Follow-up ────────────────────────────────────────────────────────────────────────────────────

const fresh = (warnings = [ADVISORY]) => ({
  id: 'fu-9',
  applicationId: 'app-1',
  n: 1 as const,
  channel: 'email' as const,
  contactId: 'contact-1',
  to: 'ada@acme.example',
  version: followupVersion(1),
  warnings,
})

test('T-F1: followupDue gives n → a new follow-up, ready when clean and draft with a block', () => {
  const clean = valueOf(newFollowup(fresh(), [], NOW))
  assert.deepEqual([clean.state, clean.n, clean.version, clean.versions.length, clean.createdAt], ['ready', 1, 1, 1, AT])
  assert.equal(valueOf(newFollowup(fresh([BLOCKER]), [], NOW)).state, 'draft')
  errorOf(newFollowup(fresh(), [followup({ n: 1, state: 'cancelled' })], NOW), 'conflict')
})

test('T-F2: a re-lint moves draft ⇄ ready', () => {
  assert.equal(f(followup({ state: 'draft', warnings: [BLOCKER] }), { type: 'relint', warnings: [] }).state, 'ready')
  assert.equal(f(followup({ state: 'ready' }), { type: 'relint', warnings: [BLOCKER] }).state, 'draft')
})

test('T-F3: an instruction on this row: draft or ready → rewriting, remembering where from', () => {
  for (const state of ['draft', 'ready'] as const) {
    const next = f(followup({ state }), { type: 'instruction' })
    assert.deepEqual([next.state, next.rewriteFrom], ['rewriting', state])
  }
})

test('T-F4: the rewrite comes back → draft or ready by its lint, a new version', () => {
  const rewriting = followup({ state: 'rewriting', rewriteFrom: 'ready' })
  const next = f(rewriting, { type: 'rewrite-returned', version: followupVersion(2, { origin: 'rewritten', instruction: 'shorter' }), warnings: [] })
  assert.deepEqual([next.state, next.version, next.versions.length, next.rewriteFrom], ['ready', 2, 2, null])
  assert.equal(f(rewriting, { type: 'rewrite-returned', version: followupVersion(2), warnings: [BLOCKER] }).state, 'draft')
})

test('T-F5: the third failure goes back to exactly rewriteFrom', () => {
  for (const from of ['draft', 'ready'] as const) {
    const next = f(followup({ state: 'rewriting', rewriteFrom: from }), { type: 'rewrite-failed' })
    assert.deepEqual([next.state, next.rewriteFrom], [from, null])
  }
})

test('T-F6: approving an email follow-up: ready → sending, while the application is sent without a human reply', () => {
  const approve = { type: 'approve', app: SENT_APP, address: ADDRESSES.verifiedToday, sendAnyway: false, cap: CAP } as const
  assert.equal(f(followup(), approve).state, 'sending')
  errorOf(followupTransition(followup(), { ...approve, app: { state: 'sent', hasHumanReply: true } }, NOW), 'conflict')
  errorOf(followupTransition(followup(), { ...approve, app: { state: 'replied', hasHumanReply: true } }, NOW), 'conflict')
  errorOf(followupTransition(followup(), { ...approve, cap: { sentToday: 2, maxPerDay: 2 } }, NOW), 'limit')
  errorOf(followupTransition(followup({ channel: 'linkedin' }), approve, NOW), 'conflict')
})

test('T-F7: «Mark as sent» of a LinkedIn note: ready → sent', () => {
  assert.equal(f(followup({ channel: 'linkedin', to: null }), { type: 'mark-sent' }).state, 'sent')
  errorOf(followupTransition(followup(), { type: 'mark-sent' }, NOW), 'conflict')
})

test('T-F8: sending → sent, failed or send-unknown, as T-S2/T-S3/T-S4', () => {
  assert.equal(f(followup({ state: 'sending' }), { type: 'smtp-accepted' }).state, 'sent')
  assert.equal(f(followup({ state: 'sending' }), { type: 'smtp-failed' }).state, 'failed')
  assert.equal(f(followup({ state: 'sending' }), { type: 'smtp-unknown' }).state, 'send-unknown')
})

test('T-F9: send-unknown → sent by «It went» or a reply, → sending by «Send again»', () => {
  const unknown = followup({ state: 'send-unknown' })
  assert.equal(f(unknown, { type: 'it-went' }).state, 'sent')
  assert.equal(f(unknown, { type: 'reply' }).state, 'sent')
  assert.equal(f(unknown, { type: 'send-again', app: SENT_APP, cap: CAP }).state, 'sending')
})

test('T-F10: «Retry» failed → sending, within the cap', () => {
  assert.equal(f(followup({ state: 'failed' }), { type: 'retry', cap: CAP }).state, 'sending')
  errorOf(followupTransition(followup({ state: 'failed' }), { type: 'retry', cap: { sentToday: 9, maxPerDay: 9 } }, NOW), 'limit')
})

test('T-F11: a human reply or a closed application cancels an unsent follow-up', () => {
  assert.equal(f(followup({ state: 'draft' }), { type: 'cancel', why: 'replied' }).state, 'cancelled')
})

test('T-F12: «Skip → not a fit» cancels a draft or ready follow-up', () => {
  for (const state of ['draft', 'ready'] as const) assert.equal(f(followup({ state }), { type: 'skip-not-a-fit' }).state, 'cancelled')
  errorOf(followupTransition(followup({ state: 'failed' }), { type: 'skip-not-a-fit' }, NOW), 'conflict')
})

test('T-F13: «It didn\'t go» of a send-unknown follow-up with the application replied → cancelled', () => {
  assert.equal(f(followup({ state: 'send-unknown' }), { type: 'it-didnt-go', app: { state: 'replied', hasHumanReply: true } }).state, 'cancelled')
})

test('T-F14: a reply that rule 1 matches with its failed send → sent', () => {
  assert.equal(f(followup({ state: 'failed' }), { type: 'reply' }).state, 'sent')
})

test('T-F15: «Switch to LinkedIn note» / «Switch to email»: same family of state, new version, channel changed', () => {
  const toLinkedin = f(followup({ state: 'ready' }), { type: 'switch-channel', to: 'linkedin', email: null, version: followupVersion(2), warnings: [] })
  assert.deepEqual([toLinkedin.channel, toLinkedin.to, toLinkedin.state, toLinkedin.version], ['linkedin', null, 'ready', 2])
  const toEmail = f(followup({ state: 'draft', channel: 'linkedin', to: null }), {
    type: 'switch-channel',
    to: 'email',
    email: 'ada@acme.example',
    version: followupVersion(2, { subject: 'Following up' }),
    warnings: [BLOCKER],
  })
  assert.deepEqual([toEmail.channel, toEmail.to, toEmail.state], ['email', 'ada@acme.example', 'draft'])
  errorOf(followupTransition(followup({ channel: 'linkedin', to: null }), { type: 'switch-channel', to: 'email', email: null, version: followupVersion(2), warnings: [] }, NOW), 'conflict')
  errorOf(followupTransition(followup(), { type: 'switch-channel', to: 'email', email: 'ada@acme.example', version: followupVersion(2), warnings: [] }, NOW), 'conflict')
})

test('a reply on a follow-up already sent or sending changes nothing', () => {
  for (const state of ['sent', 'sending'] as const) {
    const row = followup({ state })
    assert.deepEqual(f(row, { type: 'reply' }), row)
  }
  errorOf(followupTransition(followup({ state: 'ready' }), { type: 'reply' }, NOW), 'conflict')
})

const approveFu: FollowupEvent = { type: 'approve', app: SENT_APP, address: ADDRESSES.verifiedToday, sendAnyway: false, cap: CAP }
const invalidFollowups: readonly { readonly from: FollowupState; readonly name: string; readonly event: FollowupEvent }[] = [
  { from: 'draft', name: 'approve (T-F6 is only ready)', event: approveFu },
  { from: 'ready', name: '«Retry»', event: { type: 'retry', cap: CAP } },
  { from: 'rewriting', name: 'approve', event: approveFu },
  { from: 'sending', name: '«Skip → not a fit» (T-F12 is only draft/ready)', event: { type: 'skip-not-a-fit' } },
  { from: 'send-unknown', name: 'cancel by a reply (T-F11 leaves it out)', event: { type: 'cancel', why: 'replied' } },
  { from: 'sent', name: 'an instruction', event: { type: 'instruction' } },
  { from: 'failed', name: '«It went»', event: { type: 'it-went' } },
  { from: 'cancelled', name: 'approve', event: approveFu },
]
for (const { from, name, event } of invalidFollowups) {
  test(`invalid follow-up: ${name} from ${from} is a conflict`, () => errorOf(followupTransition(followup({ state: from }), event, NOW), 'conflict'))
}

// ── Address ──────────────────────────────────────────────────────────────────────────────────────

test('T-D1: a new contact with an email is unverified, or verified when the package gives it as seen; checkedAt null', () => {
  const bare = contact(null)
  const unverified = d(bare, { type: 'create', email: 'ada@acme.example', seen: null })
  assert.deepEqual([unverified.email, unverified.address], ['ada@acme.example', { status: 'unverified', verifiedUrl: null, checkedAt: null, override: null }])
  const verified = d(bare, { type: 'create', email: 'ada@acme.example', seen: { url: 'https://acme.example/team' } })
  assert.deepEqual(verified.address, { status: 'verified', verifiedUrl: 'https://acme.example/team', checkedAt: null, override: null })
  errorOf(addressTransition(contact(ADDRESSES.verifiedToday), { type: 'create', email: 'ada@acme.example', seen: null }, NOW), 'conflict')
  errorOf(addressTransition(bare, { type: 'create', email: '[correo]', seen: null }, NOW), 'invalid')
})

test('T-D2: queueing a check: unverified (or stale verified) → checking, the override intact', () => {
  for (const address of [ADDRESSES.unverifiedNeverChecked, ADDRESSES.unverifiedToday, ADDRESSES.unverifiedStaleOverride, ADDRESSES.verifiedStale]) {
    const next = d(contact(address), { type: 'enqueue-check' })
    assert.deepEqual([next.address?.status, next.address?.override], ['checking', address.override])
  }
})

test('T-D3: N2 finds it literally: checking → verified with its url and checkedAt', () => {
  const next = d(contact(ADDRESSES.checking), { type: 'check-found', url: 'https://acme.example/about' })
  assert.deepEqual(next.address, { status: 'verified', verifiedUrl: 'https://acme.example/about', checkedAt: AT, override: null })
})

test('T-D4: not found, no website, no network or past the deadline: checking → unverified with checkedAt', () => {
  const kept = { ...ADDRESSES.checking, override: { at: TODAY } }
  const next = d(contact(kept), { type: 'check-missed', timedOut: true })
  assert.deepEqual(next.address, { status: 'unverified', verifiedUrl: null, checkedAt: AT, override: { at: TODAY } })
})

test('T-D4 on a stale verified address re-checked: the old verifiedUrl goes, the address was not seen this time', () => {
  const rechecking = d(contact(ADDRESSES.verifiedStale), { type: 'enqueue-check' })
  assert.equal(rechecking.address?.verifiedUrl, 'https://acme.example/contact')
  const next = d(rechecking, { type: 'check-missed' })
  assert.deepEqual(next.address, { status: 'unverified', verifiedUrl: null, checkedAt: AT, override: null })
})

test('T-D5: «Send anyway» on a finished, fresh check writes the override; never on a stale or unchecked one', () => {
  const next = d(contact(ADDRESSES.unverifiedToday), { type: 'send-anyway' })
  assert.deepEqual(next.address?.override, { at: AT })
  errorOf(addressTransition(contact(ADDRESSES.unverifiedNeverChecked), { type: 'send-anyway' }, NOW), 'conflict', 'check-pending')
  errorOf(addressTransition(contact(ADDRESSES.unverifiedStaleOverride), { type: 'send-anyway' }, NOW), 'conflict', 'check-pending')
})

test('T-D6: at startup, checking → unverified with checkedAt null', () => {
  assert.deepEqual(d(contact(ADDRESSES.checking), { type: 'restart' }).address?.status, 'unverified')
})

test('T-D7: «Edit address» resets the state, the check and the override; refuses a bad address', () => {
  for (const address of [null, ADDRESSES.unverifiedTodayOverride, ADDRESSES.verifiedToday]) {
    const next = d(contact(address), { type: 'edit', email: 'grace@acme.example' })
    assert.equal(next.email, 'grace@acme.example')
    assert.deepEqual(next.address, { status: 'unverified', verifiedUrl: null, checkedAt: null, override: null })
  }
  errorOf(addressTransition(contact(ADDRESSES.verifiedToday), { type: 'edit', email: '[correo]@acme' }, NOW), 'invalid')
})

const invalidAddresses: readonly { readonly name: string; readonly row: Contact; readonly event: AddressEvent }[] = [
  { name: 'an N2 result on unverified that is not checking (T-D3)', row: contact(ADDRESSES.unverifiedToday), event: { type: 'check-found', url: 'https://acme.example' } },
  { name: '«Send anyway» on checking (T-D5 never in checking)', row: contact(ADDRESSES.checking), event: { type: 'send-anyway' } },
  { name: '«Send anyway» on verified', row: contact(ADDRESSES.verifiedToday), event: { type: 'send-anyway' } },
  { name: '«Edit address» on checking (T-D7 leaves it out, v6 M7)', row: contact(ADDRESSES.checking), event: { type: 'edit', email: 'grace@acme.example' } },
]
for (const { name, row, event } of invalidAddresses) {
  test(`invalid address: ${name} is a conflict`, () => errorOf(addressTransition(row, event, NOW), 'conflict'))
}

test('an address event on a contact without an address is a conflict, except create and edit', () => {
  for (const type of ['enqueue-check', 'send-anyway', 'restart'] as const) errorOf(addressTransition(contact(null), { type }, NOW), 'conflict')
  errorOf(addressTransition(contact(null), { type: 'check-missed' }, NOW), 'conflict')
})
