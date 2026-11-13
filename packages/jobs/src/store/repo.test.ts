import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type Db, type Queries } from './db.ts'
import * as repo from './repo.ts'
import { addressTransition, appTransition, followupTransition, sendTransition } from '../state.ts'
import { ADDRESSES, application, CAP, contact, followup, NOW, send, valueOf } from '../test-state.ts'
import { tempBase, type TempBase } from '../test-support.ts'
import { fail, ok, type Company, type Opportunity, type Profile, type Result } from '../types.ts'

const AT = NOW.toISOString()

const company: repo.NewCompany = {
  id: 'company-1',
  name: 'Acme',
  nameKey: 'acme',
  domain: 'acme.example',
  website: 'https://acme.example',
  careersUrl: null,
  linkedin: null,
  sector: 'software',
  size: { value: '50', source: 'linkedin' },
  location: 'Sydney',
  isHealthEmployer: false,
  healthSource: null,
  ats: { kind: 'greenhouse', ref: 'acme' },
  record: 'employee_count 50',
}

const opportunity: Opportunity = {
  id: 'opp-1',
  companyId: 'company-1',
  kind: 'vacancy',
  title: 'Graduate engineer',
  goalId: 'sydney-semester',
  url: 'https://acme.example/jobs/1',
  postedAt: null,
  closesAt: null,
  startsAt: null,
  duration: null,
  hours: '16-20',
  salary: null,
  requirements: 'TypeScript',
  score: 80,
  breakdown: null,
  profileVersion: 1,
  source: 'seed',
  sourceRef: null,
  remote: null,
  status: 'open',
  discardReason: null,
  checkedAt: null,
}

const note = { kind: 'imported' } as const

async function seeded(base: TempBase): Promise<Db> {
  const opened = await openDb({ dir: base.dir, now: () => NOW })
  if (!opened.ok) assert.fail(opened.error.reason)
  const db = opened.value
  valueOf(
    db.tx((q) => {
      repo.insertCompany(q, company, note, NOW)
      repo.insertContact(q, contact(ADDRESSES.unverifiedToday), note, NOW)
      repo.insertOpportunity(q, opportunity, 'acme|graduate', note, NOW)
      return ok(undefined)
    }),
  )
  return db
}

const eventCount = (db: Db): number => db.read((q) => q.all('SELECT id FROM events').length)
const write = <T>(db: Db, fn: (q: Queries) => T): T => valueOf(db.tx((q) => ok(fn(q))))

test('a company, its contact, an opportunity and an application round-trip, frozen all the way down', async () => {
  using base = tempBase()
  const db = await seeded(base)
  const app = application({ sends: [send({ state: 'sent', attempts: [{ messageId: '<old@x>', at: AT, reason: 'x' }] })], warnings: [{ code: 'too-long', where: 'letter', detail: 'd', blocks: false, overridden: null }] })
  write(db, (q) => repo.insertApplication(q, app, { seedKey: 'pkg-1#3' }, note, NOW))
  const read = db.read((q) => ({
    company: repo.getCompany(q, 'company-1'),
    contact: repo.getContact(q, 'contact-1'),
    opportunity: repo.getOpportunity(q, 'opp-1'),
    app: repo.getApplication(q, 'app-1'),
  }))
  const { nameKey: _nameKey, record: _record, ...fields } = company
  const expected: Company = { ...fields, contacts: [contact(ADDRESSES.unverifiedToday)] }
  assert.deepEqual(read.company, expected)
  assert.deepEqual(read.contact, contact(ADDRESSES.unverifiedToday))
  assert.deepEqual(read.opportunity, opportunity)
  assert.deepEqual(read.app, app)
  assert.ok(Object.isFrozen(read.app) && Object.isFrozen(read.app?.sends) && Object.isFrozen(read.app?.sends[0]?.attempts[0]))
  assert.ok(Object.isFrozen(read.company?.contacts[0]?.address))
  assert.equal(db.read((q) => repo.companyRecord(q, 'company-1')), 'employee_count 50')
  assert.equal(db.read((q) => repo.getApplication(q, 'nope')), undefined)
  db.close()
})

test('every function that writes state leaves exactly one event, in the same transaction', async () => {
  using base = tempBase()
  const db = await seeded(base)
  write(db, (q) => repo.insertApplication(q, application(), { seedKey: null }, note, NOW))
  write(db, (q) => repo.insertFollowup(q, followup({ state: 'draft' }), note, NOW))
  const writers: readonly { readonly name: string; readonly run: (q: Queries) => unknown }[] = [
    { name: 'insertCompany', run: (q) => repo.insertCompany(q, { ...company, id: 'company-2', nameKey: 'beta' }, note, NOW) },
    { name: 'insertContact', run: (q) => repo.insertContact(q, contact(null, { id: 'contact-2' }), note, NOW) },
    { name: 'saveContact', run: (q) => repo.saveContact(q, contact(ADDRESSES.checking), { kind: 'address-checked' }, NOW) },
    { name: 'insertOpportunity', run: (q) => repo.insertOpportunity(q, { ...opportunity, id: 'opp-2' }, 'acme|other', note, NOW) },
    { name: 'insertApplication', run: (q) => repo.insertApplication(q, application({ id: 'app-2' }), { seedKey: null }, note, NOW) },
    { name: 'saveApplication', run: (q) => repo.saveApplication(q, application({ state: 'in-review' }), { kind: 'relinted' }, NOW) },
    { name: 'insertFollowup', run: (q) => repo.insertFollowup(q, followup({ id: 'fu-2', n: 2 }), { kind: 'followup-proposed' }, NOW) },
    { name: 'saveFollowup', run: (q) => repo.saveFollowup(q, followup({ state: 'ready' }), { kind: 'relinted' }, NOW) },
    { name: 'insertProfileVersion', run: (q) => repo.insertProfileVersion(q, { version: 7, createdAt: AT, profile: {} as Profile }, { kind: 'profile-saved' }, NOW) },
    { name: 'insertRule', run: (q) => repo.insertRule(q, { id: 'rule-1', text: 'Never say passionate', scope: 'all', enabled: true, createdAt: AT, updatedAt: AT }, { kind: 'rule-saved' }, NOW) },
  ]
  for (const { name, run } of writers) {
    const before = eventCount(db)
    // A body that writes and then gives !ok: the row AND its event go together.
    const rolledBack: Result<never> = db.tx((q) => {
      run(q)
      return fail('conflict', 'undo')
    })
    assert.equal(rolledBack.ok, false)
    assert.equal(eventCount(db), before, `${name}: no event after a rollback`)
    write(db, run)
    assert.equal(eventCount(db), before + 1, `${name}: one event`)
  }
  db.close()
})

test('appendEvent carries the application, the company, the data and both times', async () => {
  using base = tempBase()
  const db = await seeded(base)
  const event = write(db, (q) => repo.appendEvent(q, { kind: 'note', applicationId: null, companyId: 'company-1', data: { text: 'x' }, at: '2026-11-01T00:00:00.000Z' }, NOW))
  assert.deepEqual({ ...event, id: 'x' }, { id: 'x', at: '2026-11-01T00:00:00.000Z', recordedAt: AT, applicationId: null, companyId: 'company-1', kind: 'note', data: { text: 'x' } })
  assert.match(event.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/)
  db.close()
})

test('saveApplication with its transition: approve inserts the initial row, «Retry» updates the same row', async () => {
  using base = tempBase()
  const db = await seeded(base)
  write(db, (q) => repo.insertApplication(q, application({ target: { ...application().target } }), { seedKey: null }, note, NOW))
  const approve = { type: 'approve', pdfExists: true, address: ADDRESSES.verifiedToday, sendAnyway: false, cap: CAP, profileVersion: 1 } as const
  const step = (fn: (app: ReturnType<typeof application>) => ReturnType<typeof application>, kind: 'approved' | 'send-failed') =>
    write(db, (q) => {
      const app = repo.getApplication(q, 'app-1')
      assert.ok(app)
      return repo.saveApplication(q, fn(app), { kind }, NOW)
    })
  step((app) => valueOf(appTransition(app, { ...approve, messageId: '<a@x>' }, NOW)), 'approved')
  step((app) => valueOf(appTransition(app, { type: 'smtp-failed', reason: 'timeout' }, NOW)), 'send-failed')
  step((app) => valueOf(appTransition(app, { ...approve, messageId: '<b@x>' }, NOW)), 'approved')
  const app = db.read((q) => repo.getApplication(q, 'app-1'))
  assert.equal(app?.state, 'sending')
  assert.deepEqual(app?.sends.map((s) => [s.kind, s.messageId, s.attempts.map((a) => a.messageId)]), [['initial', '<b@x>', ['<a@x>']]])
  assert.deepEqual(db.read((q) => repo.eventsOf(q, 'app-1')).map((e) => e.kind), ['imported', 'approved', 'send-failed', 'approved'])
  db.close()
})

test('follow-ups: create, read by application and by contact, apply a transition with its send and event', async () => {
  using base = tempBase()
  const db = await seeded(base)
  write(db, (q) => repo.insertApplication(q, application({ state: 'sent', sends: [send({ state: 'sent' })] }), { seedKey: null }, note, NOW))
  write(db, (q) => repo.insertFollowup(q, followup(), { kind: 'followup-proposed', data: { n: 1 } }, NOW))
  const fu = db.read((q) => repo.getFollowup(q, 'fu-1'))
  assert.deepEqual(fu, followup())
  assert.deepEqual(db.read((q) => repo.followupsOf(q, 'app-1')), [followup()])
  assert.deepEqual(db.read((q) => repo.followupsOfContact(q, 'contact-1')), [followup()])
  assert.ok(fu)
  const moved = valueOf(followupTransition(fu, { type: 'approve', app: { state: 'sent', hasHumanReply: false }, address: ADDRESSES.verifiedToday, sendAnyway: false, cap: CAP }, NOW))
  const row = valueOf(sendTransition(null, { type: 'approve', kind: 'followup-1', followupId: 'fu-1', messageId: '<f@x>', addressOverride: false, profileVersion: 1 }, NOW))
  write(db, (q) => repo.saveFollowup(q, moved, { kind: 'approved', data: { kind: 'followup-1' } }, NOW, row))
  const app = db.read((q) => repo.getApplication(q, 'app-1'))
  assert.equal(app?.state, 'sent', 'a follow-up never changes the application state')
  assert.deepEqual(app?.sends.map((s) => [s.kind, s.state]), [['initial', 'sent'], ['followup-1', 'sending']])
  assert.equal(db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, 'sending')
  const events = db.read((q) => repo.eventsOf(q, 'app-1'))
  assert.deepEqual(events.at(-1)?.data, { kind: 'followup-1', followupId: 'fu-1' })
  db.close()
})

test('a follow-up never reaches sending, sent, failed or send-unknown without its own send row', async () => {
  using base = tempBase()
  const db = await seeded(base)
  write(db, (q) => repo.insertApplication(q, application({ state: 'sent', sends: [send({ state: 'sent' })] }), { seedKey: null }, note, NOW))
  write(db, (q) => repo.insertFollowup(q, followup({ state: 'ready' }), { kind: 'followup-proposed' }, NOW))
  const before = eventCount(db)
  const own = (state: 'sending' | 'sent' | 'failed' | 'send-unknown') => send({ kind: 'followup-1', followupId: 'fu-1', messageId: '<f1@x>', state })
  for (const state of ['sending', 'sent', 'failed', 'send-unknown'] as const) {
    const missing = db.tx((q) => repo.saveFollowup(q, followup({ state }), { kind: 'approved' }, NOW))
    assert.deepEqual(missing, { ok: false, error: { code: 'conflict', reason: `a follow-up in ${state} needs its send row` } })
    const other = db.tx((q) => repo.saveFollowup(q, followup({ state }), { kind: 'approved' }, NOW, send({ kind: 'followup-1', followupId: 'fu-9', state })))
    assert.equal(other.ok, false, `${state}: a row of another follow-up`)
    const outOfStep = db.tx((q) => repo.saveFollowup(q, followup({ state }), { kind: 'approved' }, NOW, own(state === 'sent' ? 'failed' : 'sent')))
    assert.equal(outOfStep.ok, false, `${state}: a row in another state`)
  }
  assert.equal(eventCount(db), before)
  assert.equal(db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, 'ready')
  assert.deepEqual(db.tx((q) => repo.saveFollowup(q, followup({ state: 'sending' }), { kind: 'approved' }, NOW, own('sending'))), { ok: true, value: undefined })
  db.close()
})

test('contacts: read by company, apply an address transition with its event', async () => {
  using base = tempBase()
  const db = await seeded(base)
  const before = db.read((q) => repo.getContact(q, 'contact-1'))
  assert.ok(before)
  const next = valueOf(addressTransition(before, { type: 'enqueue-check' }, NOW))
  write(db, (q) => repo.saveContact(q, next, { kind: 'address-checked', data: { queued: true } }, NOW))
  assert.deepEqual(db.read((q) => repo.contactsOfCompany(q, 'company-1')), [next])
  const events = db.read((q) => q.all<{ company_id: string; data: string }>("SELECT company_id, data FROM events WHERE kind = 'address-checked'"))
  assert.deepEqual(events.map((e) => [e.company_id, JSON.parse(e.data)]), [['company-1', { queued: true, contactId: 'contact-1' }]])
  db.close()
})

test('the startup write: every sending row → send-unknown, running work → queued, checking contacts → unverified', async () => {
  using base = tempBase()
  const db = await seeded(base)
  write(db, (q) => {
    repo.insertContact(q, contact({ ...ADDRESSES.checking, checkedAt: '2026-11-01T00:00:00.000Z', override: { at: '2026-11-01T00:00:00.000Z' } }, { id: 'contact-2' }), note, NOW)
    repo.insertApplication(q, application({ id: 'app-initial', state: 'sending', sends: [send({ messageId: '<i@x>' })] }), { seedKey: null }, note, NOW)
    repo.insertApplication(q, application({ id: 'app-followup', state: 'sent', sends: [send({ messageId: '<s@x>', state: 'sent' })] }), { seedKey: null }, note, NOW)
    repo.insertFollowup(q, followup({ id: 'fu-9', applicationId: 'app-followup', state: 'sending' }), note, NOW)
    q.run("INSERT INTO sends (application_id, kind, followup_id, channel, message_id, state, at) VALUES ('app-followup', 'followup-1', 'fu-9', 'smtp', '<f@x>', 'sending', ?)", AT)
    q.run("INSERT INTO work (id, kind, ref, lane, state, created_at, updated_at) VALUES ('w1', 'cv', 'app-initial', 'gen', 'running', ?, ?), ('w2', 'cv', 'x', 'gen', 'queued', ?, ?)", AT, AT, AT, AT)
    return undefined
  })
  const recovered = write(db, (q) => repo.recoverOnStart(q, NOW))
  assert.deepEqual(recovered, { sends: 2, work: 1, contacts: 1 })
  const read = db.read((q) => ({
    initial: repo.getApplication(q, 'app-initial'),
    followupApp: repo.getApplication(q, 'app-followup'),
    fu: repo.getFollowup(q, 'fu-9'),
    work: q.all<{ id: string; state: string }>('SELECT id, state FROM work ORDER BY id'),
    contact: repo.getContact(q, 'contact-2'),
  }))
  assert.deepEqual([read.initial?.state, read.initial?.sends[0]?.state], ['send-unknown', 'send-unknown'])
  assert.equal(read.followupApp?.state, 'sent', 'a follow-up in sending leaves the application sent')
  assert.deepEqual(read.followupApp?.sends.map((s) => s.state), ['sent', 'send-unknown'])
  assert.equal(read.fu?.state, 'send-unknown')
  assert.deepEqual(read.work, [{ id: 'w1', state: 'queued' }, { id: 'w2', state: 'queued' }])
  assert.deepEqual(read.contact?.address, { status: 'unverified', verifiedUrl: null, checkedAt: null, override: { at: '2026-11-01T00:00:00.000Z' } })
  const kinds = db.read((q) => q.all<{ kind: string; data: string }>("SELECT kind, data FROM events WHERE kind IN ('send-unknown', 'address-checked') ORDER BY rowid"))
  assert.deepEqual(kinds.map((e) => [e.kind, JSON.parse(e.data)]), [
    ['send-unknown', { kind: 'initial', restarted: true }],
    ['send-unknown', { kind: 'followup-1', followupId: 'fu-9', restarted: true }],
    ['address-checked', { found: false, restarted: true, contactId: 'contact-2' }],
  ])
  assert.deepEqual(write(db, (q) => repo.recoverOnStart(q, NOW)), { sends: 0, work: 0, contacts: 0 })
  db.close()
})

test('the startup write resolves a sending row even when its owner is out of step, and says so', async () => {
  using base = tempBase()
  const db = await seeded(base)
  write(db, (q) => {
    // An initial `sending` under an application that is `ready`, and a follow-up row with no follow-up.
    repo.insertApplication(q, application({ state: 'ready', sends: [send({ messageId: '<i@x>' })] }), { seedKey: null }, note, NOW)
    q.run("INSERT INTO sends (application_id, kind, channel, message_id, state, at) VALUES ('app-1', 'followup-1', 'smtp', '<f@x>', 'sending', ?)", AT)
    return undefined
  })
  assert.equal(write(db, (q) => repo.recoverOnStart(q, NOW)).sends, 2)
  const app = db.read((q) => repo.getApplication(q, 'app-1'))
  assert.deepEqual([app?.state, ...(app?.sends.map((s) => s.state) ?? [])], ['ready', 'send-unknown', 'send-unknown'])
  const data = db.read((q) => q.all<{ data: string }>("SELECT data FROM events WHERE kind = 'send-unknown' ORDER BY rowid")).map((e) => JSON.parse(e.data))
  assert.deepEqual(data, [
    { kind: 'initial', restarted: true, followupId: null, ownerOutOfStep: true },
    { kind: 'followup-1', restarted: true, followupId: null, ownerOutOfStep: true },
  ])
  db.close()
})

test('applications by state, profile versions, rules and meta', async () => {
  using base = tempBase()
  const db = await seeded(base)
  write(db, (q) => {
    repo.insertApplication(q, application({ id: 'a', state: 'ready' }), { seedKey: null }, note, NOW)
    repo.insertApplication(q, application({ id: 'b', state: 'draft' }), { seedKey: null }, note, NOW)
    repo.insertProfileVersion(q, { version: 1, createdAt: AT, profile: { level: 'junior' } as unknown as Profile }, { kind: 'profile-saved' }, NOW)
    repo.insertProfileVersion(q, { version: 2, createdAt: AT, profile: { level: 'mid' } as unknown as Profile }, { kind: 'profile-saved' }, NOW)
    repo.insertRule(q, { id: 'r1', text: 'Never say passionate', scope: 'email', enabled: true, createdAt: AT, updatedAt: AT }, { kind: 'rule-saved' }, NOW)
    repo.updateRule(q, { id: 'r1', text: 'Never say passionate', scope: 'email', enabled: false, createdAt: AT, updatedAt: AT }, { kind: 'rule-saved' }, NOW)
    repo.setMeta(q, 'lastReplyPoll', AT)
    repo.setMeta(q, 'lastReplyPoll', '2026-11-15T00:00:00.000Z')
    return undefined
  })
  assert.deepEqual(db.read((q) => repo.applicationsByState(q, ['ready', 'in-review'])).map((a) => a.id), ['a'])
  assert.equal(db.read((q) => repo.latestProfileVersion(q))?.version, 2)
  assert.deepEqual(db.read((q) => repo.latestProfileVersion(q))?.profile, { level: 'mid' })
  assert.deepEqual(db.read((q) => repo.listRules(q)).map((r) => [r.id, r.enabled]), [['r1', false]])
  assert.equal(db.read((q) => repo.getRule(q, 'r1'))?.scope, 'email')
  assert.equal(db.read((q) => repo.getRule(q, 'nope')), undefined)
  assert.equal(db.read((q) => repo.getMeta(q, 'lastReplyPoll')), '2026-11-15T00:00:00.000Z')
  assert.equal(db.read((q) => repo.getMeta(q, 'nope')), undefined)
  db.close()
})

test('an empty store has no profile, and unknown ids read as undefined', async () => {
  using base = tempBase()
  const db = await seeded(base)
  assert.equal(db.read((q) => repo.latestProfileVersion(q)), undefined)
  assert.equal(db.read((q) => repo.getCompany(q, 'nope')), undefined)
  assert.equal(db.read((q) => repo.getContact(q, 'nope')), undefined)
  assert.equal(db.read((q) => repo.getOpportunity(q, 'nope')), undefined)
  assert.equal(db.read((q) => repo.getFollowup(q, 'nope')), undefined)
  assert.equal(db.read((q) => repo.companyRecord(q, 'nope')), undefined)
  db.close()
})
