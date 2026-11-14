import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { NotificationMessage } from '@factotum/core'
import { appOf, eventsOf, insertApp, insertFollowup, queueStore } from '../ai/test-queue.ts'
import { openReview } from '../review/open.ts'
import { applyDeferredReplies } from '../send/deferred.ts'
import { appTransition } from '../state.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { errorOf, NOW, send, valueOf } from '../test-state.ts'
import { capturedLog, tempBase } from '../test-support.ts'
import type { Application, JobEvent, Send } from '../types.ts'
import { applyReply, assignReply, PUSH_COMPANY_MAX, recordUnmatched } from './apply.ts'
import type { ClassifyVerdict, ReplyJob } from './classify.ts'
import type { ReplyClass } from './match.ts'
import type { ReadReply } from './read.ts'

const SENT_AT = '2026-11-10T00:00:00.000Z'
const MAIL_DATE = '2026-11-13T05:00:00.000Z'
const M1 = '<m1@jobs.factotum.local>'
const F1 = '<f1@jobs.factotum.local>'

type Match = ReadReply['match']

const THREAD: Match = { kind: 'thread', rule: 1, applicationId: 'app-1', sendKind: 'initial', viaAttempt: false, messageId: M1 }
const BY_DOMAIN: Match = { kind: 'candidates', rule: 2, applicationIds: ['app-1'] }
const BY_ATS: Match = { kind: 'candidates', rule: 3, applicationIds: ['app-1'] }

let uid = 10

function job(match: Match, over: Partial<ReadReply> = {}): ReplyJob {
  uid += 1
  const reply: ReadReply = {
    key: `7:${uid}`,
    uidValidity: 7,
    uid,
    messageId: `<r${uid}@acme.example>`,
    from: 'Ada Lovelace <ada@acme.example>',
    fromAddress: 'ada@acme.example',
    subject: 'Re: Application',
    date: MAIL_DATE,
    receivedAt: MAIL_DATE,
    gmailLink: 'https://mail.google.com/mail/u/owner/#all/abc',
    list: false,
    match,
    body: 'THE BODY — never stored',
    ...over,
  }
  return { reply, input: { from: reply.from, subject: reply.subject, body: reply.body, candidates: [] } }
}

const verdict = (cls: ReplyClass, applicationId: string | null = null): ClassifyVerdict => ({ class: cls, applicationId, summary: `Summary of ${cls}.` })

interface Applied {
  readonly pushes: NotificationMessage[]
}

function apply(db: Db, replyJob: ReplyJob, given: ClassifyVerdict, pushes: NotificationMessage[] = []): Applied {
  valueOf(db.tx((q) => applyReply(q, replyJob, given, NOW, { push: (_key, message) => pushes.push(message) })))
  return { pushes }
}

const kinds = (db: Db, id = 'app-1'): readonly string[] => eventsOf(db, id).map((e) => e.kind)
const lastOf = (db: Db, kind: string, id = 'app-1'): JobEvent | undefined => eventsOf(db, id).filter((e) => e.kind === kind).at(-1)
const sendOf = (app: Application, kind: Send['kind'] = 'initial'): Send | undefined => app.sends.find((s) => s.kind === kind)

/** A follow-up 1 of app-1 and its send row (written after the follow-up: the row references it). */
function withFollowup(db: Db, state: Send['state'], extra: Partial<Send> = {}): void {
  insertFollowup(db, { id: 'fu-1', state })
  const app = appOf(db, 'app-1')
  const row = send({ kind: 'followup-1', followupId: 'fu-1', state, messageId: F1, at: SENT_AT, ...extra })
  valueOf(db.tx((q) => repo.saveApplication(q, { ...app, sends: [...app.sends, row] }, { kind: 'note' }, NOW)))
}

async function store(base: { dir: string }, app: Partial<Application> = {}): Promise<Db> {
  const db = await queueStore({ dir: base.dir, [Symbol.dispose]: () => undefined })
  insertApp(db, { id: 'app-1', state: 'sent', sends: [send({ state: 'sent', at: SENT_AT })], ...app })
  return db
}

// ── Always: the event ────────────────────────────────────────────────────────────────────────────

test('Q4: an interview in the thread → `reply` with the MAIL’s date, class, sender, subject, Gmail link and summary, never the body; replied; one push', async () => {
  using base = tempBase()
  const db = await store(base)
  insertFollowup(db, { id: 'fu-1', state: 'draft' })

  const replyJob = job(THREAD)
  const { pushes } = apply(db, replyJob, verdict('interview'))

  const event = lastOf(db, 'reply')
  assert.equal(event?.at, MAIL_DATE, 'the date of the mail, not of the read')
  assert.deepEqual(event?.data, {
    key: replyJob.reply.key,
    class: 'interview',
    rule: 1,
    messageId: M1,
    from: 'Ada Lovelace <ada@acme.example>',
    subject: 'Re: Application',
    link: 'https://mail.google.com/mail/u/owner/#all/abc',
    summary: 'Summary of interview.',
  })
  assert.equal(JSON.stringify(eventsOf(db, 'app-1')).includes('THE BODY'), false, 'the body is never written')
  assert.deepEqual([appOf(db, 'app-1').state, appOf(db, 'app-1').outcome], ['replied', 'interview'])
  assert.equal(db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, 'cancelled', 'T-F11: an unsent follow-up is cancelled')
  assert.deepEqual(pushes, [{ title: 'Interview: Acme', body: 'Tap to open.', path: '/m/jobs/a/app-1', tag: 'jobs-reply-app-1' }])
  const seen = db.read((q) => q.get<{ application_id: string; class: string }>('SELECT application_id, class FROM mail_seen WHERE key = ?', replyJob.reply.key))
  assert.deepEqual({ ...seen }, { application_id: 'app-1', class: 'interview' })
})

test('Q4: an offer pushes «Offer: <company>», cut to 40 characters; the summary never goes to the push', async () => {
  using base = tempBase()
  const db = await store(base)
  const long = 'An Extremely Long Company Name That Keeps Going Pty Ltd'
  db.read((q) => q.run('UPDATE companies SET name = ? WHERE id = ?', long, 'company-1'))

  const { pushes } = apply(db, job(THREAD), verdict('offer'))

  assert.equal(PUSH_COMPANY_MAX, 40)
  assert.deepEqual(pushes.map((p) => p.title), [`Offer: ${long.slice(0, 39)}…`])
  assert.equal(JSON.stringify(pushes).includes('Summary'), false)
  assert.equal(appOf(db, 'app-1').outcome, 'offer')
})

test('Q4: `asks-something` → replied without push, and it heads the next batch', async () => {
  using base = tempBase()
  const db = await store(base)
  insertApp(db, { id: 'app-2', state: 'ready' })

  const { pushes } = apply(db, job(THREAD), verdict('asks-something'))

  assert.deepEqual([appOf(db, 'app-1').state, pushes.length], ['replied', 0])
  const review = openReview({ db, now: () => NOW, timeZone: 'Australia/Sydney', enqueueChecks: () => undefined, log: capturedLog().log })
  const batch = valueOf(review.startBatch())
  assert.equal(batch.items[0]?.kind, 'reply')
  assert.equal(batch.items[0]?.kind === 'reply' && batch.items[0].eventId, lastOf(db, 'reply')?.id)
})

test('Q4: the guard is `mail_seen` — the same mail applied twice writes once', async () => {
  using base = tempBase()
  const db = await store(base)
  const replyJob = job(THREAD)
  const pushes: NotificationMessage[] = []
  apply(db, replyJob, verdict('interview'), pushes)
  apply(db, replyJob, verdict('interview'), pushes)
  assert.equal(kinds(db).filter((k) => k === 'reply').length, 1)
  assert.equal(pushes.length, 1)
})

// ── send-unknown (A7, T-S7, T-A17) ───────────────────────────────────────────────────────────────

test('Q4: initial `send-unknown` + a reply in the thread → `sent` and `replied` in one tx, with `resolved-by-reply`', async () => {
  using base = tempBase()
  const db = await store(base, { state: 'send-unknown', sends: [send({ state: 'send-unknown', at: SENT_AT })] })

  apply(db, job(THREAD), verdict('interview'))

  const app = appOf(db, 'app-1')
  assert.deepEqual([sendOf(app)?.state, app.state], ['sent', 'replied'])
  assert.deepEqual(lastOf(db, 'resolved-by-reply')?.data, { kind: 'initial', rule: 1 })
  assert.deepEqual(kinds(db).slice(-2), ['resolved-by-reply', 'reply'], 'resolved before the reply')
})

test('Q4: initial `send-unknown` + a human reply matched ONLY by domain → also `sent` (rule 2) and `replied` (v6, H2)', async () => {
  using base = tempBase()
  const db = await store(base, { state: 'send-unknown', sends: [send({ state: 'send-unknown', at: SENT_AT })] })

  apply(db, job(BY_DOMAIN), verdict('rejection', 'app-1'))

  const app = appOf(db, 'app-1')
  assert.deepEqual([sendOf(app)?.state, app.state, app.outcome], ['sent', 'closed', 'rejected'])
  assert.deepEqual(lastOf(db, 'resolved-by-reply')?.data, { kind: 'initial', rule: 2 })
})

test('Q4: `followup-1` in `send-unknown` + a reply with its messageId → its follow-up `sent`, the application `replied`', async () => {
  using base = tempBase()
  const db = await store(base)
  withFollowup(db, 'send-unknown')

  apply(db, job({ ...THREAD, sendKind: 'followup-1', messageId: F1 }), verdict('interview'))

  const app = appOf(db, 'app-1')
  assert.deepEqual([sendOf(app, 'followup-1')?.state, db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, app.state], ['sent', 'sent', 'replied'])
  assert.deepEqual(lastOf(db, 'resolved-by-reply')?.data, { kind: 'followup-1', rule: 1, followupId: 'fu-1' })
})

test('Q4: `followup-1` in `send-unknown` + a reply matched ONLY by domain → the follow-up stays `send-unknown` (only rule 1 proves it)', async () => {
  using base = tempBase()
  const db = await store(base)
  withFollowup(db, 'send-unknown')

  apply(db, job(BY_DOMAIN), verdict('interview', 'app-1'))

  const app = appOf(db, 'app-1')
  assert.deepEqual([sendOf(app, 'followup-1')?.state, db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, app.state], ['send-unknown', 'send-unknown', 'replied'])
  assert.equal(lastOf(db, 'resolved-by-reply'), undefined)
})

test('Q4 (v6.1): initial `send-unknown` after a «Retry» + a reply citing the `attempts` messageId → `sent` with `viaAttempt`, and the class decides', async () => {
  using base = tempBase()
  const retried = send({ state: 'send-unknown', messageId: '<new@jobs.factotum.local>', attempts: [{ messageId: M1, at: SENT_AT, reason: 'timeout' }] })
  const db = await store(base, { state: 'send-unknown', sends: [retried] })

  apply(db, job({ ...THREAD, viaAttempt: true }), verdict('auto-ack'))

  const app = appOf(db, 'app-1')
  assert.deepEqual([sendOf(app)?.state, app.state], ['sent', 'sent'], 'T-A17 then T-A29')
  assert.deepEqual(lastOf(db, 'resolved-by-reply')?.data, { kind: 'initial', rule: 1, viaAttempt: true })
})

// ── A sender Gmail did not vouch for (D12 «Remitente verificado») ────────────────────────────────

test('D12: an interview by domain from an unverified sender → an «Unmatched reply» with `unverifiedSender`; no state, no send resolved, no follow-up cancelled, no push', async () => {
  using base = tempBase()
  const db = await store(base, { state: 'send-unknown', sends: [send({ state: 'send-unknown', at: SENT_AT })] })
  insertFollowup(db, { id: 'fu-1', state: 'draft' })
  const before = kinds(db)

  const forged = job({ ...BY_DOMAIN, unverifiedSender: true })
  const { pushes } = apply(db, forged, verdict('interview', 'app-1'))

  const app = appOf(db, 'app-1')
  assert.deepEqual([app.state, sendOf(app)?.state, db.read((q) => repo.getFollowup(q, 'fu-1'))?.state], ['send-unknown', 'send-unknown', 'draft'])
  assert.deepEqual(kinds(db), before, 'nothing on the application')
  assert.deepEqual(pushes, [])
  const unmatched = db.read((q) => repo.unmatchedReplies(q))
  assert.deepEqual(unmatched.map((u) => [u.key, u.class, u.candidates, u.unverifiedSender]), [[forged.reply.key, 'interview', ['app-1'], true]])
  assert.equal(db.read((q) => repo.mailSeen(q, forged.reply.key, null)), true)
})

test('D12: an unverified sender by ATS, even `unrelated`, is still shown for the owner to judge', async () => {
  using base = tempBase()
  const db = await store(base)
  apply(db, job({ ...BY_ATS, unverifiedSender: true }), verdict('unrelated'))
  assert.deepEqual(db.read((q) => repo.unmatchedReplies(q)).map((u) => u.unverifiedSender), [true])
})

// ── Only a human reply changes the state (v6, H1; T-A29) ─────────────────────────────────────────

test('Q4: an auto-ack and then an interview from the same ATS domain → after the ack still `sent`, the draft follow-up stays; after the interview `replied`, cancelled, ONE push', async () => {
  using base = tempBase()
  const db = await store(base)
  insertFollowup(db, { id: 'fu-1', state: 'draft' })
  const pushes: NotificationMessage[] = []

  apply(db, job(BY_ATS, { from: 'no-reply@greenhouse-mail.io' }), verdict('auto-ack', 'app-1'), pushes)
  assert.deepEqual([appOf(db, 'app-1').state, db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, pushes.length], ['sent', 'draft', 0])

  apply(db, job(BY_ATS, { from: 'recruiting@greenhouse-mail.io' }), verdict('interview', 'app-1'), pushes)
  const app = appOf(db, 'app-1')
  assert.deepEqual([app.state, app.outcome, db.read((q) => repo.getFollowup(q, 'fu-1'))?.state], ['replied', 'interview', 'cancelled'])
  assert.deepEqual(eventsOf(db, 'app-1').filter((e) => e.kind === 'reply').map((e) => e.data.class), ['auto-ack', 'interview'])
  assert.deepEqual(pushes.map((p) => p.title), ['Interview: Acme'])
})

test('Q4: an auto-ack on a `closed` application does not reopen it', async () => {
  using base = tempBase()
  const db = await store(base, { state: 'closed', outcome: 'no-response' })
  apply(db, job(THREAD), verdict('auto-ack'))
  assert.deepEqual([appOf(db, 'app-1').state, appOf(db, 'app-1').outcome], ['closed', 'no-response'])
  assert.equal(lastOf(db, 'reopened-by-reply'), undefined)
})

// ── On `replied` and `closed` (v5, X1; T-A23–T-A25): never a conflict ────────────────────────────

test('Q4: a rejection on `replied` → `closed` `rejected`', async () => {
  using base = tempBase()
  const db = await store(base, { state: 'replied', outcome: 'interview' })
  apply(db, job(BY_DOMAIN), verdict('rejection', 'app-1'))
  assert.deepEqual([appOf(db, 'app-1').state, appOf(db, 'app-1').outcome], ['closed', 'rejected'])
})

test('Q4: an interview on a `closed` (no-response) → `replied` with `reopened-by-reply`, and a push', async () => {
  using base = tempBase()
  const db = await store(base, { state: 'closed', outcome: 'no-response' })
  const { pushes } = apply(db, job(BY_DOMAIN), verdict('interview', 'app-1'))
  assert.deepEqual([appOf(db, 'app-1').state, appOf(db, 'app-1').outcome], ['replied', 'interview'])
  assert.deepEqual(lastOf(db, 'reopened-by-reply')?.data, { outcomeBefore: 'no-response', class: 'interview' })
  assert.deepEqual(kinds(db).slice(-2), ['reopened-by-reply', 'reply'])
  assert.equal(pushes.length, 1)
})

test('Q4: a rejection on `closed` → stays `closed`, now `rejected`', async () => {
  using base = tempBase()
  const db = await store(base, { state: 'closed', outcome: 'no-response' })
  apply(db, job(BY_DOMAIN), verdict('rejection', 'app-1'))
  assert.deepEqual([appOf(db, 'app-1').state, appOf(db, 'app-1').outcome], ['closed', 'rejected'])
})

// ── A reply to a `failed` send (v6, M3; T-S11, T-A30, T-F14) ─────────────────────────────────────

const failedAfterRetry = (): Send =>
  send({ state: 'failed', messageId: '<retry@jobs.factotum.local>', reason: 'smtp 550', attempts: [{ messageId: M1, at: SENT_AT, reason: 'timeout' }] })

test('Q4: `ready` with its initial `failed` after a failed «Retry» + an interview in the earlier attempt’s thread → `sent`, `resolved-by-reply`, `sent → replied`, out of the open batch', async () => {
  using base = tempBase()
  const db = await store(base, { state: 'ready', sends: [failedAfterRetry()] })
  const review = openReview({ db, now: () => NOW, timeZone: 'Australia/Sydney', enqueueChecks: () => undefined, log: capturedLog().log })
  const opened = valueOf(review.startBatch())
  assert.ok(opened.items.some((i) => i.kind === 'application' && i.applicationId === 'app-1'))

  apply(db, job({ ...THREAD, viaAttempt: true }), verdict('interview'))

  const app = appOf(db, 'app-1')
  assert.deepEqual([sendOf(app)?.state, sendOf(app)?.reason, app.state], ['sent', null, 'replied'])
  assert.deepEqual(lastOf(db, 'resolved-by-reply')?.data, { kind: 'initial', rule: 1, viaAttempt: true })
  const after = valueOf(review.batch())
  assert.equal(after?.items.some((i) => i.kind === 'application' && i.applicationId === 'app-1'), false)
})

test('Q4: the same with an auto-ack → `sent` (T-A30, then T-A29)', async () => {
  using base = tempBase()
  const db = await store(base, { state: 'ready', sends: [failedAfterRetry()] })
  apply(db, job({ ...THREAD, viaAttempt: true }), verdict('auto-ack'))
  assert.deepEqual([sendOf(appOf(db, 'app-1'))?.state, appOf(db, 'app-1').state], ['sent', 'sent'])
})

test('Q4: a `followup-1` `failed` matched by its messageId → `sent` (T-F14), not cancelled', async () => {
  using base = tempBase()
  const db = await store(base)
  withFollowup(db, 'failed', { reason: 'smtp 550' })

  apply(db, job({ ...THREAD, sendKind: 'followup-1', messageId: F1 }), verdict('interview'))

  assert.deepEqual([db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, appOf(db, 'app-1').state], ['sent', 'replied'])
})

test('Q4 (v6.1): an `approved` form (after T-A10) with its initial `failed` + a reply in the thread → `sent` (T-A30), no conflict', async () => {
  using base = tempBase()
  const db = await store(base, { state: 'approved', channel: 'form', sends: [send({ state: 'failed', reason: 'smtp 550', at: SENT_AT })] })
  apply(db, job(THREAD), verdict('auto-ack'))
  assert.deepEqual([sendOf(appOf(db, 'app-1'))?.state, appOf(db, 'app-1').state], ['sent', 'sent'])
  assert.deepEqual(lastOf(db, 'resolved-by-reply')?.data, { kind: 'initial', rule: 1 })
})

// ── The initial in flight (v6.1) ─────────────────────────────────────────────────────────────────

test('Q4 (v6.1): with the initial `sending` → only `reply { deferred: true }`, no state change, no push; the close of the send applies it', async () => {
  using base = tempBase()
  const db = await store(base, { state: 'sending', sends: [send({ state: 'sending', at: SENT_AT })] })

  const { pushes } = apply(db, job(THREAD), verdict('interview'))

  assert.deepEqual([appOf(db, 'app-1').state, pushes.length], ['sending', 0])
  assert.equal(lastOf(db, 'reply')?.data.deferred, true)
  assert.equal(lastOf(db, 'reply')?.data.messageId, M1)

  valueOf(
    db.tx((q) => {
      const accepted = valueOf(appTransition(appOf(db, 'app-1'), { type: 'smtp-accepted', response: '250 OK' }, NOW))
      valueOf(repo.saveApplication(q, accepted, { kind: 'sent' }, NOW))
      return applyDeferredReplies(q, 'app-1', NOW)
    }),
  )
  assert.deepEqual([appOf(db, 'app-1').state, appOf(db, 'app-1').outcome], ['replied', 'interview'])
})

// ── No application: an «Unmatched reply» ────────────────────────────────────────────────────────

test('Q4: several candidates and Claude names none → an «Unmatched reply» (sender and subject), not an application’s', async () => {
  using base = tempBase()
  const db = await store(base)
  insertApp(db, { id: 'app-2', state: 'sent', sends: [send({ state: 'sent', messageId: '<m2@jobs.factotum.local>', at: SENT_AT })] })
  const replyJob = job({ kind: 'candidates', rule: 3, applicationIds: ['app-1', 'app-2'] })

  apply(db, replyJob, verdict('interview', null))

  assert.equal(lastOf(db, 'reply'), undefined)
  const unmatched = db.read((q) => repo.unmatchedReplies(q))
  assert.deepEqual(
    unmatched.map((u) => [u.key, u.from, u.subject, u.at, u.class]),
    [[replyJob.reply.key, 'Ada Lovelace <ada@acme.example>', 'Re: Application', MAIL_DATE, 'interview']],
  )
})

test('Q4: several candidates, none named, and `unrelated` → only seen, nothing to show', async () => {
  using base = tempBase()
  const db = await store(base)
  const replyJob = job({ kind: 'candidates', rule: 3, applicationIds: ['app-1', 'app-2'] })
  apply(db, replyJob, verdict('unrelated', null))
  assert.deepEqual(db.read((q) => repo.unmatchedReplies(q)), [])
  assert.equal(db.read((q) => repo.mailSeen(q, replyJob.reply.key, null)), true)
})

test('Q4: an unmatched mail (rule 4) is recorded with sender, subject and link, and seen', async () => {
  using base = tempBase()
  const db = await store(base)
  const replyJob = job({ kind: 'unmatched', rule: 4 }, { subject: 'Offer of employment', from: 'hr@unknown.example', body: '' })

  valueOf(db.tx((q) => recordUnmatched(q, replyJob.reply, NOW)))
  valueOf(db.tx((q) => recordUnmatched(q, replyJob.reply, NOW)))

  const unmatched = db.read((q) => repo.unmatchedReplies(q))
  assert.deepEqual(
    unmatched.map((u) => [u.key, u.from, u.subject, u.link, u.class]),
    [[replyJob.reply.key, 'hr@unknown.example', 'Offer of employment', 'https://mail.google.com/mail/u/owner/#all/abc', null]],
    'once',
  )
  assert.equal(db.read((q) => repo.mailSeen(q, replyJob.reply.key, null)), true)
})

// ── «Assign to…» and «Ignore» (Q5, crit. 56) ─────────────────────────────────────────────────────

function unmatchedIn(db: Db, over: Partial<ReadReply> = {}, given: ClassifyVerdict | null = null): ReplyJob {
  const replyJob = job({ kind: 'unmatched', rule: 4 }, { body: '', ...over })
  valueOf(db.tx((q) => recordUnmatched(q, replyJob.reply, NOW, given)))
  return replyJob
}

const assign = (db: Db, key: string, applicationId: string | null, pushes: NotificationMessage[] = []) =>
  db.tx((q) => assignReply(q, key, applicationId, NOW, { push: (_key, message) => pushes.push(message) }))

test('Q5 «Ignore»: the unmatched reply leaves the list, with a `reply-applied { ignored }`; twice is not-found', async () => {
  using base = tempBase()
  const db = await store(base)
  const { reply } = unmatchedIn(db)

  valueOf(assign(db, reply.key, null))

  assert.deepEqual(db.read((q) => repo.unmatchedReplies(q)), [])
  const cited = db.read((q) => q.get<{ data: string }>("SELECT data FROM events WHERE kind = 'reply-applied'"))
  assert.equal(JSON.parse(cited?.data ?? '{}').ignored, true)
  errorOf(assign(db, reply.key, null), 'not-found')
})

test('Q5 «Assign to…» a rule-4 mail: a `reply` on that application with sender, subject, link and the mail’s date, `assigned`, no class — nothing else moves', async () => {
  using base = tempBase()
  const db = await store(base)
  const { reply } = unmatchedIn(db, { subject: 'Your interview', from: 'hr@unknown.example' })

  valueOf(assign(db, reply.key, 'app-1'))

  const event = lastOf(db, 'reply')
  assert.equal(event?.at, MAIL_DATE)
  assert.deepEqual(event?.data, { key: reply.key, from: 'hr@unknown.example', subject: 'Your interview', link: reply.gmailLink, assigned: true })
  assert.equal(appOf(db, 'app-1').state, 'sent')
  assert.deepEqual(db.read((q) => repo.unmatchedReplies(q)), [])
})

test('Q5 «Assign to…» a mail Claude classified but could not place: the class decides, as by its domain (rule 2), with its push', async () => {
  using base = tempBase()
  const db = await store(base, { state: 'send-unknown', sends: [send({ state: 'send-unknown', at: SENT_AT })] })
  const { reply } = unmatchedIn(db, {}, verdict('interview'))
  const pushes: NotificationMessage[] = []

  valueOf(assign(db, reply.key, 'app-1', pushes))

  const app = appOf(db, 'app-1')
  assert.deepEqual([sendOf(app)?.state, app.state, app.outcome], ['sent', 'replied', 'interview'])
  assert.equal(lastOf(db, 'reply')?.data.assigned, true)
  assert.deepEqual(pushes.map((p) => p.title), ['Interview: Acme'])
})

test('Q5 «Assign to…» an application that does not exist, or a key with nothing waiting → not-found', async () => {
  using base = tempBase()
  const db = await store(base)
  const { reply } = unmatchedIn(db)
  errorOf(assign(db, reply.key, 'nope'), 'not-found')
  errorOf(assign(db, '9:9', 'app-1'), 'not-found')
  assert.equal(db.read((q) => repo.unmatchedReplies(q)).length, 1, 'still waiting')
})
