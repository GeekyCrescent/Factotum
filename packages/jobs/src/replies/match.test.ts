import { test } from 'node:test'
import assert from 'node:assert/strict'

import { appOf, queueStore } from '../ai/test-queue.ts'
import { createTestApplication } from '../dev/test-application.ts'
import { application, NOW, send, valueOf } from '../test-state.ts'
import { tempBase } from '../test-support.ts'
import type { Application, Send } from '../types.ts'
import {
  ATS_DOMAINS,
  matchReply,
  messageIdsIn,
  REPLY_CANDIDATE_DAYS,
  replyCandidates,
  RULE3_MAX_CANDIDATES,
  senderDomain,
  type MatchApp,
  type MatchMail,
} from './match.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString()

const sent = (over: Partial<Send> = {}): Send => send({ state: 'sent', at: daysAgo(10), ...over })

function app(id: string, over: Partial<Application> = {}, extra: Partial<Omit<MatchApp, 'application'>> = {}): MatchApp {
  return {
    application: application({ id, state: 'sent', sends: [sent({ messageId: `<${id}@jobs.factotum.local>` })], ...over }),
    domain: 'acme.example',
    company: 'Acme',
    lastHumanReplyAt: null,
    ...extra,
  }
}

function mail(over: Partial<MatchMail> = {}): MatchMail {
  return { messageId: '<r1@mail.example>', inReplyTo: [], references: [], from: 'jane@elsewhere.example', fromName: '', subject: 'Hello', senderVerified: true, ...over }
}

const world = (apps: readonly MatchApp[]) => ({ apps, now: NOW })

// ── Rule 1: the thread ───────────────────────────────────────────────────────────────────────────

test('rule 1: In-Reply-To carrying the messageId of a sent initial → that application and send', () => {
  const match = matchReply(mail({ inReplyTo: ['<a1@jobs.factotum.local>'] }), world([app('a1'), app('a2')]))
  assert.deepEqual(match, { kind: 'thread', rule: 1, applicationId: 'a1', sendKind: 'initial', viaAttempt: false, messageId: '<a1@jobs.factotum.local>' })
})

test('rule 1: References carrying the messageId of a follow-up → that follow-up send', () => {
  const followup = sent({ kind: 'followup-1', followupId: 'f1', messageId: '<f1@jobs.factotum.local>' })
  const a1 = app('a1', { sends: [sent({ messageId: '<a1@jobs.factotum.local>' }), followup] })
  const match = matchReply(mail({ references: ['<other@x.example>', '<f1@jobs.factotum.local>'] }), world([a1]))
  assert.deepEqual(match, { kind: 'thread', rule: 1, applicationId: 'a1', sendKind: 'followup-1', viaAttempt: false, messageId: '<f1@jobs.factotum.local>' })
})

test('rule 1 has no 60-day cap and ignores the state: an application `ready` whose initial `failed` matches by its current messageId (v6, M3)', () => {
  const failed = sent({ state: 'failed', at: daysAgo(400), messageId: '<old@jobs.factotum.local>' })
  const ready = app('a1', { state: 'ready', sends: [failed] })
  const match = matchReply(mail({ inReplyTo: ['<old@jobs.factotum.local>'] }), world([ready]))
  assert.deepEqual(match, { kind: 'thread', rule: 1, applicationId: 'a1', sendKind: 'initial', viaAttempt: false, messageId: '<old@jobs.factotum.local>' })
})

test('rule 1 also matches an earlier messageId of the row’s `attempts` history (v5, X6), and says so', () => {
  const retried = sent({ state: 'send-unknown', messageId: '<new@jobs.factotum.local>', attempts: [{ messageId: '<first@jobs.factotum.local>', at: daysAgo(3), reason: 'timeout' }] })
  const match = matchReply(mail({ references: ['<first@jobs.factotum.local>'] }), world([app('a1', { state: 'send-unknown', sends: [retried] })]))
  assert.deepEqual(match, { kind: 'thread', rule: 1, applicationId: 'a1', sendKind: 'initial', viaAttempt: true, messageId: '<first@jobs.factotum.local>' })
})

test('rule 1 matches a row still `sending` (Q4 writes a deferred reply for it)', () => {
  const sending = sent({ state: 'sending', messageId: '<s@jobs.factotum.local>' })
  const match = matchReply(mail({ inReplyTo: ['<s@jobs.factotum.local>'] }), world([app('a1', { state: 'sending', sends: [sending] })]))
  assert.equal(match.kind === 'thread' && match.applicationId, 'a1')
})

test('rule 1 goes before rule 2: a thread reply from another candidate’s domain is the thread’s', () => {
  const other = app('a2', { companyId: 'company-2' }, { domain: 'beta.example' })
  const match = matchReply(mail({ from: 'hr@beta.example', inReplyTo: ['<a1@jobs.factotum.local>'] }), world([app('a1'), other]))
  assert.equal(match.kind === 'thread' && match.applicationId, 'a1')
})

test('rule 1: the test application (C1) is matched by its thread', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const created = valueOf(createTestApplication(db, { now: () => NOW }, { to: 'owner@example.test' }))
  const testApp = { ...appOf(db, created.id), state: 'sent' as const, sends: [sent({ messageId: '<test@jobs.factotum.local>' })] }
  const match = matchReply(mail({ inReplyTo: ['<test@jobs.factotum.local>'] }), world([{ application: testApp, domain: null, company: 'Test', lastHumanReplyAt: null }]))
  assert.deepEqual(match, { kind: 'thread', rule: 1, applicationId: created.id, sendKind: 'initial', viaAttempt: false, messageId: '<test@jobs.factotum.local>' })
})

// ── Rule 2: the domain ───────────────────────────────────────────────────────────────────────────

test('rule 2: the sender’s domain is the company’s → that one candidate, with no messageId needed', () => {
  const match = matchReply(mail({ from: 'ada@acme.example' }), world([app('a1')]))
  assert.deepEqual(match, { kind: 'candidates', rule: 2, applicationIds: ['a1'] })
})

test('rule 2 strips mail., mg. and email. from the sender’s domain', () => {
  for (const prefix of ['mail.', 'mg.', 'email.']) {
    const match = matchReply(mail({ from: `no-reply@${prefix}acme.example` }), world([app('a1')]))
    assert.deepEqual(match, { kind: 'candidates', rule: 2, applicationIds: ['a1'] }, prefix)
  }
  assert.equal(matchReply(mail({ from: 'x@hr.acme.example' }), world([app('a1')])).kind, 'ignored', 'any other subdomain is not the company’s')
})

test('rule 2: several candidates of that domain all go to Claude', () => {
  const match = matchReply(mail({ from: 'ada@ACME.example' }), world([app('a1'), app('a2'), app('b1', {}, { domain: 'beta.example' })]))
  assert.deepEqual(match, { kind: 'candidates', rule: 2, applicationIds: ['a1', 'a2'] })
})

test('rule 2: a by-hand `sent` with no messageId (the `manual` row S6b imports, v5 Y2) matches by domain', () => {
  const manual = app('a1', { sends: [sent({ channel: 'manual', messageId: null, artifactsVersion: null })] })
  assert.deepEqual(matchReply(mail({ from: 'ada@acme.example' }), world([manual])), { kind: 'candidates', rule: 2, applicationIds: ['a1'] })
})

test('rule 2: a `send-unknown` application is a candidate (v6, H2: its initial), so a domain match reaches it', () => {
  const unknown = app('a1', { state: 'send-unknown', sends: [sent({ state: 'send-unknown' })] })
  assert.deepEqual(matchReply(mail({ from: 'ada@acme.example' }), world([unknown])), { kind: 'candidates', rule: 2, applicationIds: ['a1'] })
})

test('rules 2–3 with a sender Gmail did not vouch for say `unverifiedSender`; rule 1 never asks', () => {
  const apps = [app('a1')]
  assert.deepEqual(matchReply(mail({ from: 'ada@acme.example', senderVerified: false }), world(apps)), { kind: 'candidates', rule: 2, applicationIds: ['a1'], unverifiedSender: true })
  assert.deepEqual(matchReply(mail({ from: 'x@lever.co', senderVerified: false }), world(apps)), { kind: 'candidates', rule: 3, applicationIds: ['a1'], unverifiedSender: true })
  const thread = matchReply(mail({ from: 'ada@acme.example', senderVerified: false, inReplyTo: ['<a1@jobs.factotum.local>'] }), world(apps))
  assert.equal(thread.kind, 'thread')
})

// ── Rule 3: the ATS ──────────────────────────────────────────────────────────────────────────────

test('rule 3: a sender of an ATS or job board (and its subdomains) → every candidate goes to Claude', () => {
  assert.ok(ATS_DOMAINS.includes('greenhouse-mail.io') && ATS_DOMAINS.includes('seek.com.au'))
  const apps = [app('a1'), app('b1', { companyId: 'company-2' }, { domain: 'beta.example' })]
  for (const from of ['no-reply@greenhouse-mail.io', 'acme@myworkday.com', 'jobs@us.greenhouse-mail.io', 'x@seek.com.au']) {
    assert.deepEqual(matchReply(mail({ from }), world(apps)), { kind: 'candidates', rule: 3, applicationIds: ['a1', 'b1'] }, from)
  }
  assert.equal(matchReply(mail({ from: 'x@notgreenhouse-mail.io' }), world(apps)).kind, 'ignored', 'a lookalike is not the ATS')
})

test(`rule 3 hands Claude at most ${RULE3_MAX_CANDIDATES} candidates, the most recently active first`, () => {
  // 25 companies, sent 1…25 days ago: c1 is the most recent.
  const apps = Array.from({ length: 25 }, (_v, i) => app(`c${i + 1}`, { companyId: `co-${i + 1}`, sends: [sent({ at: daysAgo(i + 1) })] }, { domain: `c${i + 1}.example`, company: `Company ${i + 1}` }))
  const match = matchReply(mail({ from: 'no-reply@greenhouse-mail.io', subject: 'Application received' }), world(apps.toReversed()))
  assert.ok(match.kind === 'candidates')
  assert.equal(RULE3_MAX_CANDIDATES, 20)
  assert.deepEqual(match.applicationIds, Array.from({ length: 20 }, (_v, i) => `c${i + 1}`))
})

test('rule 3 narrows to the companies the subject or the sender’s name mentions, when any does', () => {
  const apps = [
    app('a1'),
    app('b1', { companyId: 'company-2' }, { domain: 'beta.example', company: 'Beta Health' }),
    app('g1', { companyId: 'company-3' }, { domain: 'gamma.example', company: 'Gamma' }),
  ]
  const bySubject = matchReply(mail({ from: 'no-reply@greenhouse-mail.io', subject: 'Your application to Beta Health — next steps' }), world(apps))
  assert.deepEqual(bySubject.kind === 'candidates' && bySubject.applicationIds, ['b1'])
  const byName = matchReply(mail({ from: 'no-reply@greenhouse-mail.io', fromName: 'Gamma Recruiting', subject: 'Interview' }), world(apps))
  assert.deepEqual(byName.kind === 'candidates' && byName.applicationIds, ['g1'])
  const partWord = matchReply(mail({ from: 'no-reply@greenhouse-mail.io', subject: 'Gammaray application' }), world(apps))
  assert.deepEqual(partWord.kind === 'candidates' && partWord.applicationIds, ['a1', 'b1', 'g1'], 'a part of a word names no one: all of them')
})

test('rule 3 with no candidate at all falls through to rule 4', () => {
  const match = matchReply(mail({ from: 'no-reply@lever.co', subject: 'Your application' }), world([]))
  assert.deepEqual(match, { kind: 'unmatched', rule: 4 })
})

// ── Rule 4 ───────────────────────────────────────────────────────────────────────────────────────

test('rule 4: «Offer of employment» that matches nothing is an «Unmatched reply» (v6, M5: offer counts)', () => {
  assert.deepEqual(matchReply(mail({ subject: 'Offer of employment' }), world([app('a1')])), { kind: 'unmatched', rule: 4 })
  for (const subject of ['Your application', 'INTERVIEW invite', 'The position', 'Role update', 'Candidate portal', 'An opportunity']) {
    assert.equal(matchReply(mail({ subject }), world([])).kind, 'unmatched', subject)
  }
})

test('rule 4: anything else is ignored', () => {
  assert.deepEqual(matchReply(mail({ subject: 'Your weekly newsletter' }), world([app('a1')])), { kind: 'ignored', rule: 4 })
})

// ── The candidates of rules 2 and 3 (v5 X1, v6 H2/M4/M5, v6.1) ────────────────────────────────────

const ids = (apps: readonly MatchApp[]): readonly string[] => replyCandidates(apps, NOW).map((a) => a.application.id)

test('candidates: `sent`, `replied` and `closed` with their last send 10 days ago are in; the window is REPLY_CANDIDATE_DAYS', () => {
  assert.equal(REPLY_CANDIDATE_DAYS, 60)
  const apps = [app('sent'), app('replied', { state: 'replied', outcome: 'interview' }), app('closed', { state: 'closed', outcome: 'no-response' })]
  assert.deepEqual(ids(apps), ['sent', 'replied', 'closed'])
})

test('candidates: a `closed` that never sent (from draft, or after a failed initial) is not one, even if its domain matches (v6, M4)', () => {
  const fromDraft = app('from-draft', { state: 'closed', outcome: 'dropped', sends: [] })
  const afterFailed = app('after-failed', { state: 'closed', outcome: 'dropped', sends: [sent({ state: 'failed' })] })
  assert.deepEqual(ids([fromDraft, afterFailed]), [])
  assert.equal(matchReply(mail({ from: 'ada@acme.example' }), world([fromDraft, afterFailed])).kind, 'ignored')
})

test('candidates: a `closed` whose last send was 61 days ago, with no human reply after, is out', () => {
  assert.deepEqual(ids([app('old', { state: 'closed', sends: [sent({ at: daysAgo(61) })] })]), [])
})

test('candidates: the window counts from the last ACTIVITY (v6, M5) — a human reply 20 days ago keeps a 70-day-old send in', () => {
  const answered = app('answered', { state: 'closed', sends: [sent({ at: daysAgo(70) })] }, { lastHumanReplyAt: daysAgo(20) })
  assert.deepEqual(ids([answered]), ['answered'])
})

test('candidates: the `closed` event does not count — closed 10 days ago, no send nor human reply in 60 days, is out', () => {
  const closedLately = app('closed-lately', { state: 'closed', outcome: 'no-response', updatedAt: daysAgo(10), sends: [sent({ at: daysAgo(80) })] })
  assert.deepEqual(ids([closedLately]), [])
})

test('candidates: the latest send counts, a follow-up included', () => {
  const followed = app('followed', { sends: [sent({ at: daysAgo(90) }), sent({ kind: 'followup-1', followupId: 'f1', messageId: '<f@x>', at: daysAgo(5) })] })
  assert.deepEqual(ids([followed]), ['followed'])
})

test('candidates: other states (in-review, ready, approved, sending) are never candidates', () => {
  const states = ['in-review', 'ready', 'approved', 'sending'] as const
  assert.deepEqual(ids(states.map((state) => app(state, { state }))), [])
})

test('candidates: the test application (`test: true`) `sent`, whose domain or ATS would match, is not one (v6.1, C1)', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const created = valueOf(createTestApplication(db, { now: () => NOW }, { to: 'owner@example.test' }))
  const testApp: MatchApp = { application: { ...appOf(db, created.id), state: 'sent', sends: [sent()] }, domain: 'example.test', company: 'Test', lastHumanReplyAt: null }
  assert.deepEqual(ids([testApp]), [])
  assert.equal(matchReply(mail({ from: 'owner@example.test', subject: 'Hi' }), world([testApp])).kind, 'ignored', 'no rule 2')
  assert.deepEqual(matchReply(mail({ from: 'no-reply@lever.co', subject: 'Your application' }), world([testApp])), { kind: 'unmatched', rule: 4 }, 'no rule 3')
})

// ── The small pure pieces ────────────────────────────────────────────────────────────────────────

test('messageIdsIn reads every <id> of header values, in order; bare ones too', () => {
  assert.deepEqual(messageIdsIn(['<a@x> <b@y>', ' <c@z>']), ['<a@x>', '<b@y>', '<c@z>'])
  assert.deepEqual(messageIdsIn(['d@w']), ['<d@w>'])
  assert.deepEqual(messageIdsIn([]), [])
})

test('senderDomain lower-cases and strips one mail./mg./email.; no @ is no domain', () => {
  assert.equal(senderDomain('Jo@Mail.Acme.Example'), 'acme.example')
  assert.equal(senderDomain('jo@mg.acme.example'), 'acme.example')
  assert.equal(senderDomain('jo@acme.example'), 'acme.example')
  assert.equal(senderDomain('nobody'), null)
})
