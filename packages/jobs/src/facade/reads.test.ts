import assert from 'node:assert/strict'
import { test } from 'node:test'

import { insertApp, queueStore } from '../ai/test-queue.ts'
import { contactHashOf } from '../build/render.ts'
import { ARTIFACTS, PROFILE } from '../build/test-cv.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { NOW, send, valueOf } from '../test-state.ts'
import { tempBase } from '../test-support.ts'
import { ok, type Profile } from '../types.ts'
import { WAVE2_FAILING } from '../clock.ts'
import { ADS_FAILING } from './ads.ts'
import { views } from './reads.ts'

const PATHS = { vault: 'ok', cvMaster: 'ok', guide: 'ok', seedCompanies: 'ok', seedKit: 'ok', seedCvs: 'ok', seedPackages: 'ok', chromium: 'ok', pdfinfo: 'ok', pdftoppm: 'ok', font: 'ok', claude: 'ok' } as const

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

test('review 1a: a sending row whose step 3 never got written is listed after 2 minutes, and health warns', async () => {
  // Arrange: one in flight for 3 minutes (step 3 lost), one that started 30 s ago, a closed one.
  using base = tempBase()
  const db = await queueStore(base)
  saveProfile(db, 2, PROFILE)
  const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString()
  insertApp(db, { id: 'a-stuck', state: 'sending', sends: [send({ messageId: '<a-stuck@jobs.factotum.local>', state: 'sending', at: ago(3 * 60_000) })] }, ARTIFACTS)
  insertApp(db, { id: 'a-moving', state: 'sending', sends: [send({ messageId: '<a-moving@jobs.factotum.local>', state: 'sending', at: ago(30_000) })] }, ARTIFACTS)
  insertApp(db, { id: 'a-test', state: 'sending', test: true, sends: [send({ messageId: '<a-test@jobs.factotum.local>', state: 'sending', at: ago(3 * 60_000) })] }, ARTIFACTS)

  // Act
  const reads = readsOf(db)
  const overview = reads.overview()

  // Assert
  assert.deepEqual(
    overview.sends.map((s) => [s.applicationId, s.kind, s.state, s.reason]),
    [['a-stuck', 'initial', 'sending', 'not confirmed — check Sent before sending again']],
  )
  const line = 'A send was not confirmed after 2 minutes — check Gmail\'s Sent before sending it again'
  assert.ok(reads.health().warnings.includes(line))
  assert.ok(overview.notices.includes(line))
})

test('review 1a: a failing wave 2, a failing ad walk and deferred replies left unapplied are health warnings', async () => {
  // Arrange
  using base = tempBase()
  const db = await queueStore(base)
  saveProfile(db, 2, PROFILE)
  insertApp(db, { id: 'a-sent', state: 'sent', sends: [send({ messageId: '<a-sent@jobs.factotum.local>', state: 'sent' })] }, ARTIFACTS)
  insertApp(db, { id: 'a-sending', state: 'sending', sends: [send({ messageId: '<a-sending@jobs.factotum.local>', state: 'sending', at: NOW.toISOString() })] }, ARTIFACTS)
  const reads = readsOf(db)
  const deferred = (id: string, app: string): void =>
    valueOf(db.tx((q) => ok(void q.run(`INSERT INTO events (id, at, recorded_at, application_id, kind, data) VALUES (?, ?, ?, ?, 'reply', '{"deferred":true,"class":"interview"}')`, id, NOW.toISOString(), NOW.toISOString(), app))))
  const lines = {
    wave2: 'Wave 2: some CVs could not be queued; the clock keeps trying',
    ads: 'Live ads: the last check of the ads in review failed',
    deferred: 'Replies that came in while an email was sending were not applied; they will be at the next restart',
  }

  // Act: a deferred reply on an application still sending is waiting, not stuck.
  deferred('r-wait', 'a-sending')
  const waiting = reads.health().warnings
  valueOf(db.tx((q) => (repo.setMeta(q, WAVE2_FAILING, NOW.toISOString()), repo.setMeta(q, ADS_FAILING, NOW.toISOString()), ok(undefined))))
  deferred('r-stuck', 'a-sent')
  const failing = reads.health().warnings

  // Assert
  assert.deepEqual(waiting, [])
  assert.deepEqual(failing, [lines.wave2, lines.ads, lines.deferred])
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

test('review 1a: an undecided item whose application left its batch state is not counted — «Start review», not «Continue review»', async () => {
  // Arrange: the batch holds the test application, closed before it was decided.
  using base = tempBase()
  const db = await queueStore(base)
  saveProfile(db, 2, PROFILE)
  insertApp(db, { id: 'a-test', state: 'closed', test: true }, ARTIFACTS)
  insertApp(db, { id: 'a-ready', state: 'ready' }, ARTIFACTS)
  valueOf(
    db.tx((q) => {
      repo.insertBatch(q, { id: 'b-1', items: [{ itemId: 'i-1', kind: 'application', applicationId: 'a-test' }], cursor: 0, results: {} }, NOW)
      return ok(undefined)
    }),
  )

  // Act
  const overview = readsOf(db).overview()

  // Assert
  assert.equal(overview.batchOpen, true)
  assert.equal(overview.batchUndecided, 0)
  assert.equal(overview.reviewable, 1)
})

test('review 1a: the printed CVs not sent — those a contact change would mark, and those already out of date', async () => {
  // Arrange: two printed with today's contact, one with another, one approved, one sent, one not printed.
  using base = tempBase()
  const db = await queueStore(base)
  saveProfile(db, 2, PROFILE)
  const current = { ...ARTIFACTS, contactHash: contactHashOf(PROFILE) }
  insertApp(db, { id: 'a-ready', state: 'ready' }, current)
  insertApp(db, { id: 'a-review', state: 'in-review' }, current)
  insertApp(db, { id: 'a-stale', state: 'in-review' }, { ...ARTIFACTS, contactHash: 'printed-with-another-phone' })
  insertApp(db, { id: 'a-approved', state: 'approved' }, current)
  insertApp(db, { id: 'a-sent', state: 'sent', sends: [send({ messageId: '<a-sent@jobs.factotum.local>', state: 'sent' })] }, current)
  insertApp(db, { id: 'a-unprinted', state: 'in-review' }, { ...ARTIFACTS, pdf: null, contactHash: null })

  // Act
  const printed = readsOf(db).printedCvs()

  // Assert
  assert.deepEqual(printed, { current: 2, stale: 1 })
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
