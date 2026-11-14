import assert from 'node:assert/strict'
import { test } from 'node:test'

import { insertApp, insertFollowup, queueStore } from '../ai/test-queue.ts'
import { ARTIFACTS, PROFILE } from '../build/test-cv.ts'
import type { SeenBatch, SeenItem } from '../review/seen.ts'
import * as repo from '../store/repo.ts'
import { followupVersion, NOW, send, valueOf } from '../test-state.ts'
import { tempBase } from '../test-support.ts'
import { ok } from '../types.ts'
import { applicationCard, batchView, readyOutside, reviewItem } from './views.ts'

const SEEN = 'a'.repeat(64)

test('C1 views: an application card fills its slots, resolves its contact, and shows its jobs and sends', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  const app = insertApp(db, { state: 'in-review', sends: [send({ state: 'failed', reason: 'refused' })] }, { ...ARTIFACTS, linkedin: 'Hi, {portfolio}', form: [{ question: 'Where?', answer: '{suburb}', ok: true, hint: null }] })
  valueOf(
    db.tx((q) => {
      repo.insertWork(q, { id: 'w-cv', kind: 'cv', ref: app.id, lane: 'bulk', state: 'failed', attempts: 3, notBefore: null, reason: 'generation failed', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
      repo.setGenRequest(q, app.id, 'cv', 'w-cv')
      repo.insertWork(q, { id: 'w-letter', kind: 'letter', ref: app.id, lane: 'bulk', state: 'queued', attempts: 0, notBefore: null, reason: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
      repo.setGenRequest(q, app.id, 'letter', 'w-letter')
      return ok(undefined)
    }),
  )

  const card = db.read((q) => applicationCard(q, app, PROFILE))

  assert.equal(card.company.name, 'Acme')
  assert.equal(card.contact?.email, 'ada@acme.example')
  assert.ok(card.letter?.body.includes(PROFILE.identity.phone), '{signature} filled')
  assert.equal(card.linkedin, `Hi, ${PROFILE.identity.portfolioUrl}`)
  assert.equal(card.form[0]?.answer, PROFILE.identity.suburb)
  assert.equal(card.cv.png, `a/${app.id}/v/1/preview.png`)
  assert.equal(card.cv.pdf, `a/${app.id}/v/1/Alex-Example-CV.pdf`)
  assert.deepEqual(card.jobs, { cv: { state: 'failed', reason: 'generation failed' }, letter: { state: 'pending', reason: null }, reprint: { state: 'idle', reason: null } })
  assert.deepEqual(card.sends.map((s) => [s.kind, s.state, s.reason]), [['initial', 'failed', 'refused']])
  assert.equal(card.formUrl, null, 'no ad URL, no careers page: the switch is off')
})

test('C1 views: follow-up, rewritten (both targets), reply and proposal items; TEST and «still rewriting»', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  insertApp(db, { id: 'a-test', state: 'rewriting', test: true, rewriteFrom: 'in-review' }, ARTIFACTS)
  insertApp(db, { id: 'a-sent', state: 'sent' }, ARTIFACTS)
  insertFollowup(db, { id: 'fu', applicationId: 'a-sent', state: 'ready', version: 2, versions: [followupVersion(1, { body: 'Before {signature}' }), followupVersion(2, { subject: 'Re: {suburb}' })] })
  const eventId = valueOf(
    db.tx((q) => {
      repo.appendEvent(q, { kind: 'instruction', data: { instruction: 'Shorter.' }, applicationId: 'a-test', companyId: 'company-1' }, NOW)
      repo.appendEvent(q, { kind: 'rewrite-failed', data: { followupId: 'fu', reason: 'timeout' }, applicationId: 'a-sent', companyId: 'company-1' }, NOW)
      const event = repo.appendEvent(q, { kind: 'reply', data: { from: 'hr@acme.example', subject: 'Re: hello', summary: 'They ask for hours.', link: null }, applicationId: 'a-sent', companyId: 'company-1' }, NOW)
      return ok(event.id)
    }),
  )
  const items: readonly SeenItem[] = [
    { itemId: 'i1', seen: SEEN, kind: 'followup', followupId: 'fu' },
    { itemId: 'i2', seen: SEEN, kind: 'rewritten', target: 'application', id: 'a-test', fromVersion: 1, failed: false },
    { itemId: 'i3', seen: SEEN, kind: 'rewritten', target: 'followup', id: 'fu', fromVersion: 1, failed: true },
    { itemId: 'i4', seen: SEEN, kind: 'reply', applicationId: 'a-sent', eventId },
    { itemId: 'i5', seen: SEEN, kind: 'proposal', proposalId: 'p1' },
    { itemId: 'i6', seen: SEEN, kind: 'application', applicationId: 'gone' },
  ]
  const batch: SeenBatch = { id: 'b1', items, cursor: 0, results: {} }

  const view = db.read((q) => batchView(q, batch, PROFILE))

  assert.equal(view.test, true)
  assert.equal(view.rewriting, 1)
  assert.deepEqual(view.items.map((i) => i.itemId), ['i1', 'i2', 'i3', 'i4', 'i5'], 'an item whose entity is gone is not shown')
  const [fu, appRewrite, fuRewrite, replyItem] = view.items
  assert.ok(fu?.kind === 'followup' && fu.followup.subject === `Re: ${PROFILE.identity.suburb}` && fu.followup.company.name === 'Acme')
  assert.ok(appRewrite?.kind === 'rewritten' && appRewrite.target === 'application')
  assert.equal(appRewrite.rewrite.instruction, 'Shorter.')
  assert.ok(appRewrite.rewrite.before?.includes(PROFILE.identity.phone))
  assert.ok(fuRewrite?.kind === 'rewritten' && fuRewrite.target === 'followup')
  assert.equal(fuRewrite.rewrite.reason, 'timeout')
  assert.ok(fuRewrite.rewrite.before?.startsWith('Before '))
  assert.ok(replyItem?.kind === 'reply')
  assert.deepEqual([replyItem.reply.from, replyItem.reply.subject, replyItem.reply.company.name], ['hr@acme.example', 'Re: hello', 'Acme'])
  assert.equal(db.read((q) => reviewItem(q, { itemId: 'x', seen: SEEN, kind: 'followup', followupId: 'nope' }, PROFILE)), null)
  assert.equal(db.read((q) => reviewItem(q, { itemId: 'x', seen: SEEN, kind: 'rewritten', target: 'followup', id: 'nope', fromVersion: 1, failed: false }, PROFILE)), null)
})

test('C1 views: ready outside the open batch, never the test one', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  insertApp(db, { id: 'in-batch', state: 'ready' })
  insertApp(db, { id: 'outside', state: 'ready' })
  insertApp(db, { id: 'test', state: 'ready', test: true })
  const batch: SeenBatch = { id: 'b', items: [{ itemId: 'i', seen: SEEN, kind: 'application', applicationId: 'in-batch' }], cursor: 0, results: {} }

  assert.equal(db.read((q) => readyOutside(q, batch.items)), 1)
  assert.equal(db.read((q) => readyOutside(q, [])), 2)
})

test('C1 views: ready outside the batch as the store keeps it — its items read as they are, a malformed one holds nothing', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  insertApp(db, { id: 'in-batch', state: 'ready' })
  insertApp(db, { id: 'rewritten', state: 'ready' })
  insertApp(db, { id: 'outside', state: 'ready' })
  valueOf(
    db.tx((q) => {
      const items = [
        { itemId: 'i1', kind: 'application', applicationId: 'in-batch' },
        { itemId: 'i2', kind: 'rewritten', target: 'application', id: 'rewritten', fromVersion: 1, failed: false },
        { itemId: 'i3', kind: 'application', applicationId: 42 },
      ]
      repo.insertBatch(q, { id: 'b', items, cursor: 0, results: {} }, NOW)
      return ok(undefined)
    }),
  )

  // The stored items, no cast: `readyOutside` reads what the store answers.
  assert.equal(db.read((q) => readyOutside(q, repo.openBatch(q)?.items ?? [])), 1)
})

test('C1 views: a form card carries what the assist panel opens and ticks — target URL, instruction, skills (R5b)', async () => {
  // Arrange
  using base = tempBase()
  const db = await queueStore(base)
  const skills = { tick: ['TypeScript', 'AWS'], doNotTick: ['Go'] }
  const app = insertApp(
    db,
    { channel: 'form', target: { contactId: null, to: null, url: 'https://acme.example/apply', contactName: null, instruction: 'the form on acme.example/apply' } },
    { ...ARTIFACTS, skills },
  )

  // Act
  const card = db.read((q) => applicationCard(q, app, PROFILE))

  // Assert
  assert.equal(card.targetUrl, 'https://acme.example/apply')
  assert.equal(card.instruction, 'the form on acme.example/apply')
  assert.deepEqual(card.skills, skills)
})

test('R8 batch view: an approved item whose send reached `sent` counts as sent, not approved; one not sent yet stays approved (crit. 37)', async () => {
  // Arrange
  using base = tempBase()
  const db = await queueStore(base)
  insertApp(db, { id: 'a-mail-sent', state: 'sent', sends: [send({ messageId: '<a-mail-sent@jobs.factotum.local>', state: 'sent' })] }, ARTIFACTS)
  insertApp(db, { id: 'a-mail-sending', state: 'sending', sends: [send({ messageId: '<a-mail-sending@jobs.factotum.local>', state: 'sending' })] }, ARTIFACTS)
  insertApp(db, { id: 'a-form-marked', state: 'sent', channel: 'form', sends: [send({ channel: 'manual', messageId: null, state: 'sent' })] }, ARTIFACTS)
  insertApp(db, { id: 'a-platform-open', state: 'approved', channel: 'platform' }, ARTIFACTS)
  insertApp(db, { id: 'a-rewritten-sent', state: 'sent', sends: [send({ messageId: '<a-rewritten-sent@jobs.factotum.local>', state: 'sent' })] }, ARTIFACTS)
  insertApp(db, { id: 'a-skipped', state: 'sent', sends: [send({ messageId: '<a-skipped@jobs.factotum.local>', state: 'sent' })] }, ARTIFACTS)
  insertApp(db, { id: 'a-base', state: 'sent', sends: [send({ messageId: '<a-base@jobs.factotum.local>', state: 'sent' })] }, ARTIFACTS)
  insertFollowup(db, { id: 'fu-sent', applicationId: 'a-base', state: 'sent', channel: 'linkedin' })
  insertFollowup(db, { id: 'fu-ready', n: 2, applicationId: 'a-base', state: 'ready' })
  const app = (itemId: string, applicationId: string): SeenItem => ({ itemId, seen: SEEN, kind: 'application', applicationId })
  const items: readonly SeenItem[] = [
    app('i1', 'a-mail-sent'),
    app('i2', 'a-mail-sending'),
    app('i3', 'a-form-marked'),
    app('i4', 'a-platform-open'),
    { itemId: 'i5', seen: SEEN, kind: 'rewritten', target: 'application', id: 'a-rewritten-sent', fromVersion: 1, failed: false },
    app('i6', 'a-skipped'),
    { itemId: 'i7', seen: SEEN, kind: 'followup', followupId: 'fu-sent' },
    { itemId: 'i8', seen: SEEN, kind: 'followup', followupId: 'fu-ready' },
  ]
  const results = { i1: 'approved', i2: 'approved', i3: 'approved', i4: 'approved', i5: 'approved', i6: 'skipped', i7: 'approved', i8: 'approved' } as const
  const batch: SeenBatch = { id: 'b', items, cursor: 8, results }

  // Act
  const view = db.read((q) => batchView(q, batch, PROFILE))

  // Assert
  assert.deepEqual(view.results, { i1: 'sent', i2: 'approved', i3: 'sent', i4: 'approved', i5: 'sent', i6: 'skipped', i7: 'sent', i8: 'approved' })
  assert.deepEqual(batch.results, results, 'the stored results are read, never rewritten')
})
