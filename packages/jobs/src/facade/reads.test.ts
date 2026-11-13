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
  assert.equal(overview.reviewable, 1, 'the ready one; never the test application')
  assert.equal(overview.batchOpen, false)
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

test('C1 overview: an open batch is continued, not counted again; a profile without a phone says so', async () => {
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
  assert.equal(overview.reviewable, 0)
  assert.equal(overview.missingPhone, true)
  assert.deepEqual(overview.notices, [])
  assert.deepEqual(overview.sends, [])
})
