import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ADDRESSES, application, contact, followup, NOW, send, valueOf } from '../test-state.ts'
import { tempBase, type TempBase } from '../test-support.ts'
import { ok, type Address, type Application, type Opportunity } from '../types.ts'
import { openDb, type Db, type Queries } from './db.ts'
import * as repo from './repo.ts'

const note = { kind: 'imported' } as const

const opportunity = (id: string, score: number | null): Opportunity => ({
  id,
  companyId: 'company-1',
  kind: 'vacancy',
  title: id,
  goalId: null,
  url: null,
  postedAt: null,
  closesAt: null,
  startsAt: null,
  duration: null,
  hours: null,
  salary: null,
  requirements: '',
  score,
  breakdown: null,
  profileVersion: null,
  source: 'seed',
  sourceRef: null,
  remote: null,
  status: 'open',
  discardReason: null,
  checkedAt: null,
})

async function emptyStore(base: TempBase): Promise<Db> {
  const db = valueOf(await openDb({ dir: base.dir, now: () => NOW }))
  write(db, (q) => {
    const company = { id: 'company-1', name: 'Acme', nameKey: 'acme', domain: null, website: null, careersUrl: null, linkedin: null, sector: null, size: null, location: null, isHealthEmployer: false, healthSource: null, ats: null, record: '' }
    repo.insertCompany(q, company, note, NOW)
  })
  return db
}

const write = <T>(db: Db, fn: (q: Queries) => T): T => valueOf(db.tx((q) => ok(fn(q))))

/** One application with its own contact (`c-<id>`) and opportunity (`o-<id>`). */
function addApp(q: Queries, id: string, app: Partial<Application>, extra: { seedKey?: string; score?: number | null; address?: Address } = {}): void {
  repo.insertContact(q, contact(extra.address ?? ADDRESSES.unverifiedNeverChecked, { id: `c-${id}` }), note, NOW)
  repo.insertOpportunity(q, opportunity(`o-${id}`, extra.score ?? null), `k-${id}`, note, NOW)
  const target = { ...application().target, contactId: `c-${id}` }
  repo.insertApplication(q, application({ id, opportunityId: `o-${id}`, target, ...app }), { seedKey: extra.seedKey ?? null }, note, NOW)
}

test('seedCheckContacts: the contacts of unsent email applications of the given files, by file then row, deduplicated', async () => {
  using base = tempBase()
  const db = await emptyStore(base)
  write(db, (q) => {
    addApp(q, 'w1', { state: 'draft' }, { seedKey: 'wave1.md#1' })
    addApp(q, 'a1', { state: 'generating' }, { seedKey: 'ads.md#1' })
    addApp(q, 'a2', { state: 'sent', sends: [send({ state: 'sent' })] }, { seedKey: 'ads.md#2' })
    addApp(q, 'a3', { state: 'draft', channel: 'form' }, { seedKey: 'ads.md#3' })
    addApp(q, 'h1', { state: 'draft' }, { seedKey: 'byhand.md#1' })
    addApp(q, 'x1', { state: 'draft' }, { seedKey: 'ads.md.bak#1' })
    addApp(q, 'a4', { state: 'in-review' }, { seedKey: 'ads.md#4' })
    // A second application of the contact of a1.
    repo.insertOpportunity(q, opportunity('o-a5', null), 'k-a5', note, NOW)
    repo.insertApplication(q, application({ id: 'a5', opportunityId: 'o-a5', state: 'ready', target: { ...application().target, contactId: 'c-a1' } }), { seedKey: 'ads.md#5' }, note, NOW)
  })
  assert.deepEqual(db.read((q) => repo.seedCheckContacts(q, ['ads.md', 'wave1.md'])), ['c-a1', 'c-a4', 'c-w1'])
  assert.deepEqual(db.read((q) => repo.seedCheckContacts(q, [])), [])
  db.close()
})

test('batchCandidateContacts: email follow-ups, then ready, then in-review by score; no test, no future hold, no other channel', async () => {
  using base = tempBase()
  const db = await emptyStore(base)
  write(db, (q) => {
    addApp(q, 'r-low', { state: 'ready' }, { score: 40 })
    addApp(q, 'review-high', { state: 'in-review' }, { score: 90 })
    addApp(q, 'r-high', { state: 'ready' }, { score: 80 })
    addApp(q, 'r-none', { state: 'ready' }, { score: null })
    addApp(q, 'held', { state: 'ready', holdUntil: '2026-12-01' }, { score: 99 })
    addApp(q, 'held-past', { state: 'ready', holdUntil: '2026-11-14' }, { score: 10 })
    addApp(q, 'test-app', { state: 'ready', test: true }, { score: 99 })
    addApp(q, 'form', { state: 'ready', channel: 'form' }, { score: 99 })
    addApp(q, 'drafted', { state: 'draft' }, { score: 99 })
    addApp(q, 'sent', { state: 'sent', sends: [send({ state: 'sent' })] }, { score: 99 })
    repo.insertFollowup(q, followup({ id: 'fu-1', applicationId: 'sent', contactId: 'c-sent', state: 'draft' }), note, NOW)
    repo.insertFollowup(q, followup({ id: 'fu-2', applicationId: 'sent', n: 2, contactId: 'c-sent', state: 'sent' }), note, NOW)
  })
  assert.deepEqual(db.read((q) => repo.batchCandidateContacts(q, NOW)), ['c-sent', 'c-r-high', 'c-r-low', 'c-held-past', 'c-r-none', 'c-review-high'])
  db.close()
})

test('saveOpportunityCheck writes checkedAt and the status of an opportunity, with its event', async () => {
  using base = tempBase()
  const db = await emptyStore(base)
  write(db, (q) => repo.insertOpportunity(q, opportunity('o-1', 50), 'k-1', note, NOW))
  const opp = db.read((q) => repo.getOpportunity(q, 'o-1'))
  assert.ok(opp !== undefined)
  write(db, (q) => repo.saveOpportunityCheck(q, { ...opp, status: 'closed', checkedAt: NOW.toISOString() }, { kind: 'ad-checked', data: { closed: true } }, NOW))
  const after = db.read((q) => repo.getOpportunity(q, 'o-1'))
  assert.deepEqual([after?.status, after?.checkedAt, after?.score], ['closed', NOW.toISOString(), 50])
  const event = db.read((q) => q.get<{ company_id: string; data: string }>("SELECT company_id, data FROM events WHERE kind = 'ad-checked'"))
  assert.deepEqual([event?.company_id, JSON.parse(event?.data ?? '{}')], ['company-1', { closed: true, opportunityId: 'o-1' }])
  db.close()
})

test('restartedContacts:the contacts the startup write moved checking → unverified that no check has touched since', async () => {
  using base = tempBase()
  const db = await emptyStore(base)
  write(db, (q) => {
    repo.insertContact(q, contact(ADDRESSES.checking, { id: 'c-1' }), note, NOW)
    repo.insertContact(q, contact(ADDRESSES.checking, { id: 'c-2' }), note, NOW)
    repo.insertContact(q, contact(ADDRESSES.unverifiedNeverChecked, { id: 'c-3' }), note, NOW)
  })
  assert.deepEqual(db.read((q) => repo.restartedContacts(q)), [])
  write(db, (q) => repo.recoverOnStart(q, NOW))
  assert.deepEqual(db.read((q) => repo.restartedContacts(q)), ['c-1', 'c-2'])
  // c-2 is enqueued again (T-D2): it is no longer «restarted».
  write(db, (q) => {
    const c2 = repo.getContact(q, 'c-2')
    if (c2?.address == null) throw new Error('c-2')
    repo.saveContact(q, { ...c2, address: { ...c2.address, status: 'checking' } }, { kind: 'address-checked', data: { state: 'pending' } }, NOW)
  })
  assert.deepEqual(db.read((q) => repo.restartedContacts(q)), ['c-1'])
  db.close()
})
