/**
 * design D3, the single transition table — the APPLICATION rows (T-A1…T-A32), one test per row,
 * and one invalid transition per state that really is not in the table (tasks B5, v5 X3).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appTransition, newApplication, type AppEvent } from './state.ts'
import { ADDRESSES, ADVISORY, application, BLOCKER, CAP, errorOf, NOW, send, valueOf } from './test-state.ts'
import type { AppState, Application } from './types.ts'

const AT = NOW.toISOString()
const approve = (overrides: Partial<Extract<AppEvent, { type: 'approve' }>> = {}): AppEvent => ({
  type: 'approve',
  pdfExists: true,
  address: ADDRESSES.verifiedToday,
  sendAnyway: false,
  cap: CAP,
  messageId: '<new@jobs.factotum.local>',
  profileVersion: 3,
  ...overrides,
})
const move = (app: Application, event: AppEvent): Application => valueOf(appTransition(app, event, NOW))

test('T-A1: draft → generating when the CV is queued', () => {
  const next = move(application({ state: 'draft', version: 0 }), { type: 'enqueue' })
  assert.equal(next.state, 'generating')
  assert.equal(next.updatedAt, AT)
})

test('T-A2: generating → ready with the CV printed and a clean lint', () => {
  const next = move(application({ state: 'generating' }), {
    type: 'generation-returned',
    pending: false,
    failed: [],
    pdfExists: true,
    warnings: [ADVISORY],
    version: 2,
  })
  assert.equal(next.state, 'ready')
  assert.equal(next.version, 2)
  assert.deepEqual(next.warnings, [ADVISORY])
})

test('T-A2: generating → in-review when the lint blocks', () => {
  const next = move(application({ state: 'generating' }), {
    type: 'generation-returned',
    pending: false,
    failed: [],
    pdfExists: true,
    warnings: [BLOCKER],
    version: 2,
  })
  assert.equal(next.state, 'in-review')
})

test('T-A3: the third failure of the CV puts missing-cv, of the letter missing-letter (v5, X8)', () => {
  const onlyCv = move(application({ state: 'generating' }), {
    type: 'generation-returned',
    pending: false,
    failed: ['cv'],
    pdfExists: false,
    warnings: [],
    version: 1,
  })
  assert.equal(onlyCv.state, 'in-review')
  assert.deepEqual(onlyCv.warnings.map((w) => [w.code, w.blocks]), [['missing-cv', true]])
  const onlyLetter = move(application({ state: 'generating' }), {
    type: 'generation-returned',
    pending: false,
    failed: ['letter'],
    pdfExists: true,
    warnings: [],
    version: 2,
  })
  assert.equal(onlyLetter.state, 'in-review')
  assert.deepEqual(onlyLetter.warnings.map((w) => w.code), ['missing-letter'])
  assert.equal(onlyLetter.version, 2, 'what did come back is kept')
  const both = move(application({ state: 'generating' }), {
    type: 'generation-returned',
    pending: false,
    failed: ['cv', 'letter'],
    pdfExists: false,
    warnings: [],
    version: 1,
  })
  assert.deepEqual(both.warnings.map((w) => w.code), ['missing-cv', 'missing-letter'])
})

test('T-A4: «Retry» of missing-cv in-review → generating, and asks only for that class', () => {
  const failed = move(application({ state: 'generating' }), {
    type: 'generation-returned',
    pending: false,
    failed: ['cv', 'letter'],
    pdfExists: false,
    warnings: [],
    version: 1,
  })
  const next = move(failed, { type: 'retry-generation', kinds: ['cv'] })
  assert.equal(next.state, 'generating')
  assert.deepEqual(next.warnings.map((w) => w.code), ['missing-letter'])
})

test('T-A4: an instruction with letter === null goes to generating, not to rewriting (v6, M9)', () => {
  const next = move(application({ state: 'in-review' }), { type: 'instruction', hasLetter: false })
  assert.equal(next.state, 'generating')
  assert.equal(next.rewriteFrom, null)
})

test('T-A5: a clean re-lint takes in-review to ready', () => {
  const next = move(application({ state: 'in-review', warnings: [BLOCKER] }), { type: 'relint', pdfExists: true, warnings: [ADVISORY] })
  assert.equal(next.state, 'ready')
  assert.deepEqual(next.warnings, [ADVISORY])
})

test('T-A6: a re-lint with a block (cv-stale) takes ready back to in-review', () => {
  const stale = { code: 'cv-stale', where: 'cv', detail: 'printed with another contact', blocks: true, overridden: null } as const
  const next = move(application({ state: 'ready' }), { type: 'relint', pdfExists: true, warnings: [stale] })
  assert.equal(next.state, 'in-review')
})

test('T-A7: an instruction on in-review or ready goes to rewriting and remembers where from', () => {
  for (const from of ['in-review', 'ready'] as const) {
    const next = move(application({ state: from }), { type: 'instruction', hasLetter: true })
    assert.equal(next.state, 'rewriting')
    assert.equal(next.rewriteFrom, from)
  }
})

test('T-A8: the rewrite comes back → in-review or ready by its lint, a new version, rewriteFrom cleared', () => {
  const rewriting = application({ state: 'rewriting', rewriteFrom: 'in-review' })
  const clean = move(rewriting, { type: 'rewrite-returned', pdfExists: true, warnings: [], version: 2 })
  assert.deepEqual([clean.state, clean.rewriteFrom, clean.version], ['ready', null, 2])
  const blocked = move(rewriting, { type: 'rewrite-returned', pdfExists: true, warnings: [BLOCKER], version: 2 })
  assert.equal(blocked.state, 'in-review')
})

test('T-A9: a rewrite that fails three times goes back to exactly rewriteFrom (A4)', () => {
  for (const from of ['in-review', 'ready'] as const) {
    const next = move(application({ state: 'rewriting', rewriteFrom: from }), { type: 'rewrite-failed' })
    assert.deepEqual([next.state, next.rewriteFrom], [from, null])
  }
})

test('T-A10: «Switch to form» keeps the state, changes the channel and sets the form url', () => {
  for (const from of ['in-review', 'ready'] as const) {
    const next = move(application({ state: from }), { type: 'switch-to-form', url: 'https://acme.example/careers' })
    assert.equal(next.state, from)
    assert.equal(next.channel, 'form')
    assert.equal(next.target.url, 'https://acme.example/careers')
  }
  errorOf(appTransition(application(), { type: 'switch-to-form', url: null }, NOW), 'conflict')
  errorOf(appTransition(application({ channel: 'platform' }), { type: 'switch-to-form', url: 'https://x.example' }, NOW), 'conflict')
})

test('T-A11: approving an email goes ready → sending with no approved in between, and a new initial row (T-S1)', () => {
  const next = move(application(), approve())
  assert.equal(next.state, 'sending')
  assert.equal(next.sends.length, 1)
  const initial = next.sends[0]
  assert.deepEqual(initial, {
    kind: 'initial',
    followupId: null,
    channel: 'smtp',
    messageId: '<new@jobs.factotum.local>',
    state: 'sending',
    at: AT,
    response: null,
    reason: null,
    addressOverride: false,
    profileVersion: 3,
    attempts: [],
  })
})

test('T-A12: approving a form, a platform or a linkedin goes to approved, with no send row', () => {
  for (const channel of ['form', 'platform', 'linkedin'] as const) {
    const next = move(application({ channel }), approve({ address: null }))
    assert.equal(next.state, 'approved')
    assert.deepEqual(next.sends, [])
  }
})

test('T-A12: a manual approve still needs the PDF and no blocks', () => {
  errorOf(appTransition(application({ channel: 'form' }), approve({ pdfExists: false }), NOW), 'blocked', 'missing-cv')
  errorOf(appTransition(application({ channel: 'form', warnings: [BLOCKER] }), approve(), NOW), 'blocked', 'lint-blocks')
})

test('T-A13: «Mark as sent» approved → sent with a manual initial row (T-S9)', () => {
  const next = move(application({ state: 'approved', channel: 'form' }), { type: 'mark-sent' })
  assert.equal(next.state, 'sent')
  assert.deepEqual(
    next.sends.map((s) => [s.kind, s.channel, s.messageId, s.state]),
    [['initial', 'manual', null, 'sent']],
  )
})

test('T-A14: SMTP accepted: sending → sent (T-S2)', () => {
  const next = move(application({ state: 'sending', sends: [send()] }), { type: 'smtp-accepted', response: '250 2.0.0 OK' })
  assert.equal(next.state, 'sent')
  assert.deepEqual([next.sends[0]?.state, next.sends[0]?.response], ['sent', '250 2.0.0 OK'])
})

test('T-A15: a failure before DATA: sending → ready, the row failed (T-S3)', () => {
  const next = move(application({ state: 'sending', sends: [send()] }), { type: 'smtp-failed', reason: '550 mailbox unavailable' })
  assert.equal(next.state, 'ready')
  assert.deepEqual([next.sends[0]?.state, next.sends[0]?.reason], ['failed', '550 mailbox unavailable'])
})

test('T-A16: a cut after DATA (or a restart): sending → send-unknown (T-S4)', () => {
  const next = move(application({ state: 'sending', sends: [send()] }), { type: 'smtp-unknown' })
  assert.equal(next.state, 'send-unknown')
  assert.equal(next.sends[0]?.state, 'send-unknown')
})

test('T-A17: «It went» send-unknown → sent (T-S5)', () => {
  const next = move(application({ state: 'send-unknown', sends: [send({ state: 'send-unknown' })] }), { type: 'it-went' })
  assert.equal(next.state, 'sent')
  assert.equal(next.sends[0]?.state, 'sent')
})

test('T-A17: a matched reply proves a send-unknown: sent (T-S7), then its class', () => {
  const app = application({ state: 'send-unknown', sends: [send({ state: 'send-unknown' })] })
  const ack = move(app, { type: 'reply', replyClass: 'auto-ack', rule: 2, messageId: null })
  assert.deepEqual([ack.state, ack.sends[0]?.state], ['sent', 'sent'])
})

test('T-A18: «Send again» send-unknown → sending with the same messageId (T-S6)', () => {
  const next = move(application({ state: 'send-unknown', sends: [send({ state: 'send-unknown' })] }), { type: 'send-again', cap: CAP })
  assert.equal(next.state, 'sending')
  assert.deepEqual([next.sends[0]?.state, next.sends[0]?.messageId], ['sending', '<m1@jobs.factotum.local>'])
  errorOf(
    appTransition(application({ state: 'send-unknown', sends: [send({ state: 'send-unknown' })] }), { type: 'send-again', cap: { sentToday: 40, maxPerDay: 40 } }, NOW),
    'limit',
  )
})

test('T-A19: a «Sent by hand» entry takes draft…approved with no sends to sent (T-S9)', () => {
  for (const from of ['draft', 'generating', 'in-review', 'ready', 'rewriting', 'approved'] as const) {
    const next = move(application({ state: from, rewriteFrom: from === 'rewriting' ? 'ready' : null }), { type: 'sent-by-hand' })
    assert.equal(next.state, 'sent')
    assert.equal(next.rewriteFrom, null)
    assert.deepEqual(next.sends.map((s) => [s.channel, s.state]), [['manual', 'sent']])
  }
})

test('T-A19: with a send already, «Sent by hand» is invalid', () => {
  errorOf(appTransition(application({ sends: [send({ state: 'failed' })] }), { type: 'sent-by-hand' }, NOW), 'conflict')
})

test('T-A20: a human reply on sent → replied, with the outcome of interview and offer', () => {
  const sent = application({ state: 'sent', sends: [send({ state: 'sent' })] })
  for (const [replyClass, outcome] of [
    ['interview', 'interview'],
    ['offer', 'offer'],
    ['asks-something', null],
  ] as const) {
    const next = move(sent, { type: 'reply', replyClass, rule: 1, messageId: '<m1@jobs.factotum.local>' })
    assert.deepEqual([next.state, next.outcome], ['replied', outcome])
  }
})

test('T-A21: a rejection on sent or replied closes it, rejected', () => {
  for (const from of ['sent', 'replied'] as const) {
    const next = move(application({ state: from, sends: [send({ state: 'sent' })] }), { type: 'reply', replyClass: 'rejection', rule: 2, messageId: null })
    assert.deepEqual([next.state, next.outcome], ['closed', 'rejected'])
  }
})

test('T-A21: followupDue = close and «Close» close a sent or replied application', () => {
  const noResponse = move(application({ state: 'sent' }), { type: 'close', reason: 'no reply after two follow-ups', outcome: 'no-response' })
  assert.deepEqual([noResponse.state, noResponse.outcome], ['closed', 'no-response'])
  const owner = move(application({ state: 'replied', outcome: 'interview' }), { type: 'close', reason: 'took another offer' })
  assert.deepEqual([owner.state, owner.outcome], ['closed', 'interview'])
  const plain = move(application({ state: 'sent' }), { type: 'close', reason: 'not interested any more' })
  assert.deepEqual([plain.state, plain.outcome], ['closed', 'dropped'])
})

test('T-A22: «Skip» with «not a fit» closes in-review and ready, dropped', () => {
  for (const from of ['in-review', 'ready'] as const) {
    const next = move(application({ state: from }), { type: 'skip-not-a-fit', reason: 'not a fit' })
    assert.deepEqual([next.state, next.outcome], ['closed', 'dropped'])
  }
  errorOf(appTransition(application({ state: 'draft' }), { type: 'skip-not-a-fit', reason: 'x' }, NOW), 'conflict')
})

test('T-A23: another human reply on replied stays replied; the outcome changes only for interview and offer', () => {
  const replied = application({ state: 'replied', outcome: 'interview', sends: [send({ state: 'sent' })] })
  const asks = move(replied, { type: 'reply', replyClass: 'asks-something', rule: 2, messageId: null })
  assert.deepEqual([asks.state, asks.outcome], ['replied', 'interview'])
  const offer = move(replied, { type: 'reply', replyClass: 'offer', rule: 2, messageId: null })
  assert.deepEqual([offer.state, offer.outcome], ['replied', 'offer'])
})

test('T-A24: a human reply reopens a closed application', () => {
  const closed = application({ state: 'closed', outcome: 'no-response', sends: [send({ state: 'sent' })] })
  const interview = move(closed, { type: 'reply', replyClass: 'interview', rule: 1, messageId: '<m1@jobs.factotum.local>' })
  assert.deepEqual([interview.state, interview.outcome], ['replied', 'interview'])
  const asks = move(closed, { type: 'reply', replyClass: 'asks-something', rule: 3, messageId: null })
  assert.deepEqual([asks.state, asks.outcome], ['replied', null])
})

test('T-A25: a rejection on closed stays closed, rejected', () => {
  const next = move(application({ state: 'closed', outcome: 'no-response', sends: [send({ state: 'sent' })] }), {
    type: 'reply',
    replyClass: 'rejection',
    rule: 2,
    messageId: null,
  })
  assert.deepEqual([next.state, next.outcome], ['closed', 'rejected'])
})

test('T-A26: «Close» before sending closes draft…approved, dropped, and needs a reason', () => {
  for (const from of ['draft', 'generating', 'in-review', 'ready', 'rewriting', 'approved'] as const) {
    const next = move(application({ state: from }), { type: 'close', reason: 'the role was filled' })
    assert.deepEqual([next.state, next.outcome, next.rewriteFrom], ['closed', 'dropped', null])
  }
  errorOf(appTransition(application(), { type: 'close', reason: '   ' }, NOW), 'invalid')
})

test('T-A27: «Unapprove» approved → ready without a send row; with one, conflict', () => {
  assert.equal(move(application({ state: 'approved', channel: 'form' }), { type: 'unapprove' }).state, 'ready')
  errorOf(appTransition(application({ state: 'approved', channel: 'form', sends: [send({ state: 'failed' })] }), { type: 'unapprove' }, NOW), 'conflict')
})

test('T-A28: «Add event» interview/offer → replied, rejection → closed; from closed it reopens', () => {
  for (const from of ['sent', 'replied', 'closed'] as const) {
    const interview = move(application({ state: from }), { type: 'add-event', kind: 'interview' })
    assert.deepEqual([interview.state, interview.outcome], ['replied', 'interview'])
    const offer = move(application({ state: from }), { type: 'add-event', kind: 'offer' })
    assert.deepEqual([offer.state, offer.outcome], ['replied', 'offer'])
    const rejection = move(application({ state: from }), { type: 'add-event', kind: 'rejection' })
    assert.deepEqual([rejection.state, rejection.outcome], ['closed', 'rejected'])
  }
  errorOf(appTransition(application({ state: 'ready' }), { type: 'add-event', kind: 'interview' }, NOW), 'conflict')
})

test('T-A29: a non-human reply leaves state and outcome alone on sent, replied and closed', () => {
  for (const [from, outcome] of [
    ['sent', null],
    ['replied', 'interview'],
    ['closed', 'no-response'],
  ] as const) {
    for (const replyClass of ['auto-ack', 'other', 'unrelated'] as const) {
      const app = application({ state: from, outcome, sends: [send({ state: 'sent' })] })
      const next = move(app, { type: 'reply', replyClass, rule: 1, messageId: '<m1@jobs.factotum.local>' })
      assert.deepEqual([next.state, next.outcome], [from, outcome])
    }
  }
})

test('T-A30: a reply that rule 1 matches with a failed initial takes the application to sent (T-S11)', () => {
  for (const from of ['generating', 'in-review', 'ready', 'rewriting', 'approved'] as const) {
    const app = application({ state: from, rewriteFrom: from === 'rewriting' ? 'ready' : null, sends: [send({ state: 'failed', reason: 'boom' })] })
    const next = move(app, { type: 'reply', replyClass: 'auto-ack', rule: 1, messageId: '<m1@jobs.factotum.local>' })
    assert.deepEqual([next.state, next.rewriteFrom, next.sends[0]?.state, next.sends[0]?.reason], ['sent', null, 'sent', null])
  }
})

test('T-A31: «It didn\'t go» send-unknown → ready, the row failed with owner-not-sent (T-S10)', () => {
  const next = move(application({ state: 'send-unknown', sends: [send({ state: 'send-unknown' })] }), { type: 'it-didnt-go' })
  assert.equal(next.state, 'ready')
  assert.deepEqual([next.sends[0]?.state, next.sends[0]?.reason], ['failed', 'owner-not-sent'])
})

test('T-A32: the test application is born draft and goes to generating in the same step', () => {
  const born = newApplication(
    {
      id: 'app-test',
      opportunityId: 'opp-test',
      companyId: 'company-test',
      channel: 'email',
      target: { contactId: 'contact-test', to: 'ferro.rayon@gmail.com', url: null, contactName: null, instruction: null },
      cvBase: null,
      holdUntil: null,
      notes: '',
      test: true,
    },
    NOW,
  )
  assert.deepEqual([born.state, born.test, born.version, born.createdAt], ['draft', true, 0, AT])
  assert.equal(move(born, { type: 'enqueue' }).state, 'generating')
})

// One invalid transition per state, each really absent from the table (tasks B5, v5 X3).
const invalid: readonly { readonly from: AppState; readonly name: string; readonly app?: Partial<Application>; readonly event: AppEvent }[] = [
  { from: 'draft', name: '«Unapprove»', event: { type: 'unapprove' } },
  { from: 'generating', name: 'an instruction (T-A7 is only in-review/ready)', event: { type: 'instruction', hasLetter: true } },
  { from: 'in-review', name: '«Mark as sent» (T-A13 is only approved)', event: { type: 'mark-sent' } },
  { from: 'ready', name: '«Unapprove»', event: { type: 'unapprove' } },
  { from: 'rewriting', name: '«Switch to form»', event: { type: 'switch-to-form', url: 'https://acme.example/careers' } },
  { from: 'approved', name: '«Send again» (T-A18 is only send-unknown)', app: { channel: 'form' }, event: { type: 'send-again', cap: CAP } },
  { from: 'sending', name: '«Close» (T-A26 leaves it out)', app: { sends: [send()] }, event: { type: 'close', reason: 'enough' } },
  { from: 'send-unknown', name: '«Close»', app: { sends: [send({ state: 'send-unknown' })] }, event: { type: 'close', reason: 'enough' } },
  { from: 'sent', name: '«Unapprove»', app: { sends: [send({ state: 'sent' })] }, event: { type: 'unapprove' } },
  { from: 'replied', name: '«Retry» of missing-cv (T-A4)', app: { sends: [send({ state: 'sent' })] }, event: { type: 'retry-generation', kinds: ['cv'] } },
  { from: 'closed', name: '«Unapprove»', event: { type: 'unapprove' } },
]

for (const { from, name, app, event } of invalid) {
  test(`invalid: ${name} from ${from} is a conflict`, () => {
    const before = application({ state: from, ...app })
    errorOf(appTransition(before, event, NOW), 'conflict')
  })
}

test('a transition never changes the object it was given', () => {
  const before = Object.freeze(application())
  const next = move(before, approve())
  assert.notEqual(next, before)
  assert.equal(before.state, 'ready')
  assert.deepEqual(before.sends, [])
})
