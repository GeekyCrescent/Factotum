import assert from 'node:assert/strict'
import { test } from 'node:test'

import { insertApp, queueStore } from '../ai/test-queue.ts'
import { ARTIFACTS, PROFILE } from '../build/test-cv.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { NOW, send, valueOf } from '../test-state.ts'
import { tempBase } from '../test-support.ts'
import { ok, type Profile } from '../types.ts'
import { views } from './reads.ts'

const PATHS = { vault: 'ok', cvMaster: 'ok', chromium: 'ok', pdfinfo: 'ok', pdftoppm: 'ok', font: 'ok' } as const

function readsOf(db: Db, mailReason: string | null = null) {
  return views({
    db,
    queue: { pausedUntil: () => null, running: () => [] },
    mail: () => (mailReason === null ? { state: 'ok', reason: null, at: NOW.toISOString() } : { state: 'bad', reason: mailReason, at: NOW.toISOString() }),
    paths: PATHS,
    stateDir: '/nowhere',
    now: () => NOW,
    timeZone: 'Australia/Sydney',
  })
}

function saveProfile(db: Db, version: number, profile: Profile): void {
  valueOf(
    db.tx((q) => {
      repo.insertProfileVersion(q, { version, createdAt: NOW.toISOString(), profile }, { kind: 'profile-saved' }, NOW)
      return ok(undefined)
    }),
  )
}

test('C1 overview: the tracker shape of the screen — counters of crit. 63, reviewable, notices and the sends that need the owner', async () => {
  // Arrange
  using base = tempBase()
  const db = await queueStore(base)
  saveProfile(db, 2, PROFILE)
  insertApp(db, { id: 'a-ready', state: 'ready' }, ARTIFACTS)
  insertApp(db, { id: 'a-review', state: 'in-review' }, ARTIFACTS)
  insertApp(db, { id: 'a-approved', state: 'approved' }, ARTIFACTS)
  insertApp(db, { id: 'a-sent', state: 'sent', sends: [send({ messageId: '<a-sent@jobs.factotum.local>', state: 'sent' })] }, ARTIFACTS)
  insertApp(db, { id: 'a-unknown', state: 'send-unknown', sends: [send({ messageId: '<a-unknown@jobs.factotum.local>', state: 'send-unknown', at: NOW.toISOString() })] }, ARTIFACTS)
  insertApp(db, { id: 'a-failed', state: 'approved', sends: [send({ messageId: '<a-failed@jobs.factotum.local>', state: 'failed', reason: 'refused', at: NOW.toISOString() })] }, ARTIFACTS)
  insertApp(db, { id: 'a-interview', state: 'replied', outcome: 'interview', sends: [send({ messageId: '<a-interview@jobs.factotum.local>', state: 'sent' })] }, ARTIFACTS)
  insertApp(db, { id: 'a-offer', state: 'closed', outcome: 'offer', sends: [send({ messageId: '<a-offer@jobs.factotum.local>', state: 'sent' })] }, ARTIFACTS)
  insertApp(db, { id: 'a-test', state: 'ready', test: true }, ARTIFACTS)

  // Act
  const overview = readsOf(db, 'Mail: password file is readable by others').overview()

  // Assert
  assert.deepEqual(overview.counts, { toReview: 2, approvedNotSent: 2, sent: 3, awaitingReply: 1, interviews: 1, offers: 1 })
  assert.equal(overview.reviewable, 1, 'what a new batch would hold: with the test application in review, it alone (D15)')
  assert.equal(overview.batchOpen, false)
  assert.equal(overview.batchUndecided, 0)
  assert.equal(overview.missingPhone, false)
  assert.deepEqual(overview.notices, ['Mail: password file is readable by others'])
  assert.deepEqual(
    overview.sends.map((s) => [s.applicationId, s.company, s.kind, s.state, s.reason]),
    [
      ['a-failed', 'Acme', 'initial', 'failed', 'refused'],
      ['a-unknown', 'Acme', 'initial', 'send-unknown', null],
    ],
  )
})

test('C1 overview: an open batch with an undecided item is continued; a profile without a phone says so', async () => {
  // Arrange
  using base = tempBase()
  const db = await queueStore(base)
  saveProfile(db, 2, { ...PROFILE, identity: { ...PROFILE.identity, phone: ' ' } })
  insertApp(db, { id: 'a-held', state: 'ready' }, ARTIFACTS)
  valueOf(
    db.tx((q) => {
      repo.insertBatch(q, { id: 'b-1', items: [{ kind: 'application', applicationId: 'a-held' }], cursor: 0, results: {} }, NOW)
      return ok(undefined)
    }),
  )

  // Act
  const overview = readsOf(db).overview()

  // Assert
  assert.equal(overview.batchOpen, true)
  assert.equal(overview.batchUndecided, 1)
  assert.equal(overview.missingPhone, true)
  assert.deepEqual(overview.notices, [])
  assert.deepEqual(overview.sends, [])
})

test('R8 overview: a finished batch with blocked items left offers a new batch of them — never a dead end (crit. 28b, D15)', async () => {
  // Arrange: the open batch is all decided; nothing is ready, one in-review (blocked) is left.
  using base = tempBase()
  const db = await queueStore(base)
  saveProfile(db, 2, PROFILE)
  insertApp(db, { id: 'a-done', state: 'approved' }, ARTIFACTS)
  insertApp(db, { id: 'a-blocked', state: 'in-review' }, ARTIFACTS)
  insertApp(db, { id: 'a-held', state: 'in-review', holdUntil: '2027-01-12' }, ARTIFACTS)
  valueOf(
    db.tx((q) => {
      repo.insertBatch(q, { id: 'b-1', items: [{ itemId: 'i-1', kind: 'application', applicationId: 'a-done' }], cursor: 1, results: { 'i-1': 'approved' } }, NOW)
      return ok(undefined)
    }),
  )

  // Act
  const overview = readsOf(db).overview()

  // Assert
  assert.equal(overview.batchOpen, true)
  assert.equal(overview.batchUndecided, 0, 'every item of the open batch has its result')
  assert.equal(overview.reviewable, 1, 'what a new batch would hold: the blocked in-review one, not the one held to 2027')
})

test('R8 overview: an open batch with an undecided item counts it; a skipped-today application is not reviewable', async () => {
  // Arrange
  using base = tempBase()
  const db = await queueStore(base)
  saveProfile(db, 2, PROFILE)
  insertApp(db, { id: 'a-open', state: 'ready' }, ARTIFACTS)
  insertApp(db, { id: 'a-skipped', state: 'in-review' }, ARTIFACTS)
  valueOf(
    db.tx((q) => {
      repo.appendEvent(q, { kind: 'skipped', applicationId: 'a-skipped', companyId: 'company-1', at: NOW.toISOString(), data: {} }, NOW)
      repo.insertBatch(q, { id: 'b-1', items: [{ itemId: 'i-1', kind: 'application', applicationId: 'a-open' }, { itemId: 'i-2', kind: 'application', applicationId: 'a-skipped' }], cursor: 1, results: { 'i-2': 'skipped' } }, NOW)
      return ok(undefined)
    }),
  )

  // Act
  const overview = readsOf(db).overview()

  // Assert
  assert.equal(overview.batchUndecided, 1)
  assert.equal(overview.reviewable, 1, 'the ready one; the one skipped today waits for tomorrow')
})

test('R6 batch answer: says the profile has no phone, so the review warns on top (crit. 15)', async () => {
  // Arrange
  using base = tempBase()
  const db = await queueStore(base)
  saveProfile(db, 2, { ...PROFILE, identity: { ...PROFILE.identity, phone: '' } })

  // Act
  const without = readsOf(db).answer(null)
  saveProfile(db, 3, PROFILE)
  const withPhone = readsOf(db).answer(null)

  // Assert
  assert.equal(without.missingPhone, true)
  assert.equal(withPhone.missingPhone, false)
})
