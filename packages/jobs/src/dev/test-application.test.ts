import assert from 'node:assert/strict'
import { test } from 'node:test'

import { appOf, eventsOf, insertApp, queueStore } from '../ai/test-queue.ts'
import { closeApplication } from '../owner/close.ts'
import * as repo from '../store/repo.ts'
import { ADDRESSES, contact, NOW, errorOf, send, valueOf } from '../test-state.ts'
import { tempBase } from '../test-support.ts'
import { ok } from '../types.ts'
import { createTestApplication, TEST_COMPANY } from './test-application.ts'

const ctx = { now: () => NOW }

test('C1 test application (T-A32): Factotum test, an unverified contact, test: true, the fixed letter, its CV queued, test-created', async () => {
  using base = tempBase()
  const db = await queueStore(base)

  const app = valueOf(createTestApplication(db, ctx, { to: 'owner@example.test' }))

  const stored = appOf(db, app.id)
  assert.equal(stored.test, true)
  assert.equal(stored.channel, 'email')
  assert.equal(stored.state, 'generating', 'T-A1 in the same tx')
  assert.equal(stored.target.to, 'owner@example.test')
  const written = db.read((q) => ({
    company: repo.getCompany(q, stored.companyId),
    contact: stored.target.contactId === null ? undefined : repo.getContact(q, stored.target.contactId),
    opportunity: repo.getOpportunity(q, stored.opportunityId),
    artifacts: repo.getArtifacts(q, stored.id, stored.version),
    requests: repo.genRequestsOf(q, stored.id),
  }))
  assert.equal(written.company?.name, TEST_COMPANY)
  assert.equal(written.company?.domain, null)
  assert.equal(written.company?.website, null)
  assert.equal(written.contact?.email, 'owner@example.test')
  assert.equal(written.contact?.address?.status, 'unverified')
  assert.equal(written.opportunity?.kind, 'outreach')
  assert.equal(written.artifacts?.letter?.subject, 'Factotum jobs — test')
  assert.ok(written.artifacts?.letter?.body.includes('{signature}'))
  assert.deepEqual(written.requests.map((r) => [r.kind, r.state]), [['cv', 'queued']])
  assert.deepEqual(eventsOf(db, app.id).map((e) => e.kind).filter((k) => k !== 'prepared'), ['test-created'])
})

test('C1 test application: a `to` that is not an address is invalid; a second one while the first is open is a conflict', async () => {
  using base = tempBase()
  const db = await queueStore(base)

  errorOf(createTestApplication(db, ctx, { to: 'not an address' }), 'invalid')
  errorOf(createTestApplication(db, ctx, { to: 'a@b.test\r\nBcc: x@y.test' }), 'invalid')
  errorOf(createTestApplication(db, ctx, {} as { to: string }), 'invalid')
  const first = valueOf(createTestApplication(db, ctx, { to: 'owner@example.test' }))
  errorOf(createTestApplication(db, ctx, { to: 'owner@example.test' }), 'conflict')

  valueOf(closeApplication(db, ctx, first.id, { reason: 'test done' }))
  const second = valueOf(createTestApplication(db, ctx, { to: 'owner@example.test' }))
  assert.notEqual(second.id, first.id, 'once the first is closed, another can be made')
  assert.equal(second.companyId, first.companyId, 'the same «Factotum test» company')
})

test('C1: neither createTestApplication nor closeApplication runs the startup write', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  insertApp(db, { id: 'sending', state: 'sending', sends: [send()] })
  insertApp(db, { id: 'to-close', state: 'ready' })
  valueOf(
    db.tx((q) => {
      repo.insertContact(q, contact(ADDRESSES.checking, { id: 'checking-contact', email: 'ops@acme.example' }), { kind: 'imported' }, NOW)
      repo.insertWork(q, { id: 'w-running', kind: 'cv', ref: 'sending', lane: 'bulk', state: 'running', attempts: 0, notBefore: null, reason: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
      return ok(undefined)
    }),
  )

  valueOf(createTestApplication(db, ctx, { to: 'owner@example.test' }))
  valueOf(closeApplication(db, ctx, 'to-close', { reason: 'not for me' }))

  const after = db.read((q) => ({ send: repo.getApplication(q, 'sending')?.sends[0]?.state, work: repo.getWork(q, 'w-running')?.state, contact: repo.getContact(q, 'checking-contact')?.address?.status }))
  assert.deepEqual(after, { send: 'sending', work: 'running', contact: 'checking' })
})
