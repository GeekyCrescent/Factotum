import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { openDb, type Db, type Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { ADDRESSES, application, contact, errorOf, NOW, send, valueOf } from '../test-state.ts'
import { capturedLog, eventually, manualClock, manualTimers, tempBase, type ManualTimers, type TempBase } from '../test-support.ts'
import { fail as errorResult, ok, type Address, type Application, type Opportunity } from '../types.ts'
import type { AddressOutcome, AddressSearch, AddressTarget } from './address.ts'
import { CHECK_DEADLINE_MS, createCheckQueue, type CheckQueue } from './checks.ts'

const DAY_MS = 86_400_000
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString()
const note = { kind: 'imported' } as const

const opportunity = (id: string, score: number | null = null): Opportunity => ({
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

const write = <T>(db: Db, fn: (q: Queries) => T): T => valueOf(db.tx((q) => ok(fn(q))))

async function emptyStore(base: TempBase): Promise<Db> {
  const db = valueOf(await openDb({ dir: base.dir, now: () => NOW }))
  write(db, (q) => {
    const company = { id: 'company-1', name: 'Acme', nameKey: 'acme', domain: 'acme.example', website: 'https://acme.example', careersUrl: null, linkedin: null, sector: null, size: null, location: null, isHealthEmployer: false, healthSource: null, ats: null, record: '' }
    repo.insertCompany(q, company, note, NOW)
  })
  return db
}

/** A contact `<id>` with the address `<id>@acme.example`. */
function addContact(q: Queries, id: string, address: Address): void {
  repo.insertContact(q, contact(address, { id, email: `${id}@acme.example` }), note, NOW)
}

/** An application `<id>` to contact `<contactId>`, with its own opportunity. */
function addApp(q: Queries, id: string, contactId: string, app: Partial<Application> = {}, extra: { seedKey?: string; score?: number } = {}): void {
  repo.insertOpportunity(q, opportunity(`o-${id}`, extra.score ?? null), `k-${id}`, note, NOW)
  const target = { ...application().target, contactId, to: `${contactId}@acme.example` }
  repo.insertApplication(q, application({ id, opportunityId: `o-${id}`, target, ...app }), { seedKey: extra.seedKey ?? null }, note, NOW)
}

interface Call {
  readonly contactId: string
  readonly signal: AbortSignal | undefined
  readonly answer: (outcome: AddressOutcome) => void
}

/** A search the test answers by hand, one call at a time. The contact id is the address's local part. */
function handSearch(): { readonly search: AddressSearch; readonly calls: Call[] } {
  const calls: Call[] = []
  const search: AddressSearch = (target: AddressTarget, signal?: AbortSignal) =>
    new Promise((resolve) => calls.push({ contactId: target.email.split('@')[0] ?? '', signal, answer: resolve }))
  return { search, calls }
}

interface Harness {
  readonly db: Db
  readonly queue: CheckQueue
  readonly calls: Call[]
  readonly timers: ManualTimers
  readonly lines: string[]
}

function harness(db: Db, search?: AddressSearch): Harness {
  const timers = manualTimers()
  const hand = handSearch()
  const { log, lines } = capturedLog()
  const queue = createCheckQueue({ db, timers: timers.timers, now: manualClock(NOW).now, search: search ?? hand.search, log })
  return { db, queue, calls: hand.calls, timers, lines }
}

const addressOf = (db: Db, id: string) => db.read((q) => repo.getContact(q, id)?.address)
const statusOf = (db: Db, id: string) => addressOf(db, id)?.status

/** Answers the running check and waits for the next one to start (or the queue to drain). */
async function answer(h: Harness, outcome: AddressOutcome): Promise<string> {
  const call = h.calls.at(-1)
  assert.ok(call !== undefined, 'no check running')
  const before = h.calls.length
  call.answer(outcome)
  await eventually(() => h.calls.length > before || h.queue.running() === null, 'the next check')
  return call.contactId
}

describe('the check queue (N4, design D9 «Cuándo se comprueba»)', () => {
  test('enqueueCheck(contactId, { front: true }) of an unverified, never-checked address puts it first and checking (T-D2)', async () => {
    using base = tempBase()
    const db = await emptyStore(base)
    write(db, (q) => {
      for (const id of ['busy', 'a', 'b', 'x']) addContact(q, id, ADDRESSES.unverifiedNeverChecked)
    })
    const h = harness(db)
    assert.deepEqual(valueOf(h.queue.enqueueCheck('busy')), 'queued')
    await eventually(() => h.calls.length === 1, 'busy running')
    valueOf(h.queue.enqueueCheck('a'))
    valueOf(h.queue.enqueueCheck('b'))
    assert.deepEqual(valueOf(h.queue.enqueueCheck('x', { front: true })), 'queued')
    assert.deepEqual(h.queue.pending(), ['x', 'a', 'b'])
    assert.equal(h.queue.running(), 'busy')
    assert.equal(statusOf(db, 'x'), 'checking')
    assert.equal(h.queue.stateOf('x'), 'pending')
    // An already pending one moves to the front; the running one stays where it is.
    assert.deepEqual(valueOf(h.queue.enqueueCheck('b', { front: true })), 'moved')
    assert.deepEqual(valueOf(h.queue.enqueueCheck('a')), 'already')
    assert.deepEqual(valueOf(h.queue.enqueueCheck('busy', { front: true })), 'already')
    assert.deepEqual(h.queue.pending(), ['b', 'x', 'a'])
    const queued = db.read((q) => q.all<{ data: string }>("SELECT data FROM events WHERE kind = 'address-checked'")).map((e) => JSON.parse(e.data))
    assert.equal(queued.length, 4)
    assert.deepEqual(queued[0], { state: 'pending', contactId: 'busy' })
    await h.queue.stop()
    db.close()
  })

  test('enqueueCheck refuses what has nothing to check, and leaves a fresh check alone', async () => {
    using base = tempBase()
    const db = await emptyStore(base)
    write(db, (q) => {
      addContact(q, 'fresh', ADDRESSES.verifiedToday)
      addContact(q, 'done', ADDRESSES.unverifiedToday)
      repo.insertContact(q, contact(null, { id: 'none' }), note, NOW)
    })
    const h = harness(db)
    assert.equal(valueOf(h.queue.enqueueCheck('fresh', { front: true })), 'fresh')
    assert.equal(valueOf(h.queue.enqueueCheck('done')), 'fresh')
    errorOf(h.queue.enqueueCheck('nobody'), 'not-found')
    errorOf(h.queue.enqueueCheck('none'), 'conflict', 'the contact has no address')
    assert.deepEqual([statusOf(db, 'fresh'), statusOf(db, 'done')], ['verified', 'unverified'])
    assert.deepEqual(h.queue.pending(), [])
    assert.equal(h.queue.stateOf('fresh'), null)
    db.close()
  })

  test('one at a time: pending → running → done, the result on the contact (T-D3, T-D4)', async () => {
    using base = tempBase()
    const db = await emptyStore(base)
    write(db, (q) => {
      addContact(q, 'a', ADDRESSES.unverifiedNeverChecked)
      addContact(q, 'b', ADDRESSES.unverifiedNeverChecked)
    })
    const h = harness(db)
    valueOf(h.queue.enqueueCheck('a'))
    valueOf(h.queue.enqueueCheck('b'))
    await eventually(() => h.calls.length === 1, 'a running')
    assert.deepEqual([h.queue.stateOf('a'), h.queue.stateOf('b')], ['running', 'pending'])
    assert.equal(h.calls.length, 1, 'b waits for a')
    assert.equal(await answer(h, { kind: 'found', url: 'https://acme.example/contact' }), 'a')
    assert.deepEqual(addressOf(db, 'a'), { status: 'verified', verifiedUrl: 'https://acme.example/contact', checkedAt: NOW.toISOString(), override: null })
    assert.equal(h.queue.stateOf('a'), 'done')
    assert.equal(h.queue.running(), 'b')
    assert.equal(await answer(h, { kind: 'not-found' }), 'b')
    await eventually(() => h.queue.idle(), 'the queue drains')
    assert.deepEqual(addressOf(db, 'b'), { status: 'unverified', verifiedUrl: null, checkedAt: NOW.toISOString(), override: null })
    assert.equal(h.timers.pending().length, 0, 'no deadline left armed')
    db.close()
  })

  test('CHECK_DEADLINE_MS (60 s, fake clock): the check is timed-out, the address unverified with checkedAt (T-D4), and the queue moves on', async () => {
    using base = tempBase()
    const db = await emptyStore(base)
    write(db, (q) => {
      addContact(q, 'slow', ADDRESSES.unverifiedNeverChecked)
      addContact(q, 'next', ADDRESSES.unverifiedNeverChecked)
    })
    const h = harness(db)
    valueOf(h.queue.enqueueCheck('slow'))
    valueOf(h.queue.enqueueCheck('next'))
    await eventually(() => h.calls.length === 1, 'slow running')
    assert.equal(CHECK_DEADLINE_MS, 60_000)
    assert.deepEqual(h.timers.pending(), [CHECK_DEADLINE_MS])
    h.timers.fire(CHECK_DEADLINE_MS)
    await eventually(() => h.calls.length === 2, 'next running')
    assert.equal(h.calls[0]?.signal?.aborted, true, 'the search is told to stop')
    assert.equal(h.queue.stateOf('slow'), 'timed-out')
    assert.deepEqual(addressOf(db, 'slow'), { status: 'unverified', verifiedUrl: null, checkedAt: NOW.toISOString(), override: null })
    const last = db.read((q) => q.get<{ data: string }>("SELECT data FROM events WHERE kind = 'address-checked' AND data LIKE '%slow%' ORDER BY rowid DESC LIMIT 1"))
    assert.deepEqual(JSON.parse(last?.data ?? '{}'), { found: false, reason: 'timed-out', timedOut: true, contactId: 'slow' })
    // A late answer to the timed-out search writes nothing.
    h.calls[0]?.answer({ kind: 'found', url: 'https://acme.example/late' })
    await answer(h, { kind: 'not-found' })
    await eventually(() => h.queue.idle(), 'the queue drains')
    assert.equal(statusOf(db, 'slow'), 'unverified')
    db.close()
  })

  test('after importing the seed: one pending check per seeded unverified address, ahead of the rest, before any CV comes back', async () => {
    // The seed rows are written here with the repo; the import itself (S5/S6) calls enqueueSeedChecks
    // with the files it sends — never a byHand one — and its integration test comes with it.
    using base = tempBase()
    const db = await emptyStore(base)
    write(db, (q) => {
      addContact(q, 'earlier', ADDRESSES.unverifiedNeverChecked)
      addContact(q, 'queued', ADDRESSES.unverifiedNeverChecked)
      for (const id of ['ad1', 'ad2', 'w1', 'w2', 'hand', 'sent', 'form']) addContact(q, id, ADDRESSES.unverifiedNeverChecked)
      addContact(q, 'seen', ADDRESSES.verifiedToday)
      addApp(q, 'w1', 'w1', { state: 'draft' }, { seedKey: 'wave1.md#1' })
      addApp(q, 'ad1', 'ad1', { state: 'generating' }, { seedKey: 'ads.md#1' })
      addApp(q, 'ad2', 'ad2', { state: 'draft' }, { seedKey: 'ads.md#2' })
      addApp(q, 'ad2b', 'ad2', { state: 'draft' }, { seedKey: 'ads.md#3' })
      addApp(q, 'seen', 'seen', { state: 'draft' }, { seedKey: 'ads.md#4' })
      addApp(q, 'sent', 'sent', { state: 'sent', sends: [send({ state: 'sent' })] }, { seedKey: 'ads.md#5' })
      addApp(q, 'form', 'form', { state: 'draft', channel: 'form' }, { seedKey: 'ads.md#6' })
      addApp(q, 'w2', 'w2', { state: 'draft' }, { seedKey: 'wave1.md#2' })
      addApp(q, 'hand', 'hand', { state: 'draft' }, { seedKey: 'byhand.md#1' })
    })
    const h = harness(db)
    valueOf(h.queue.enqueueCheck('earlier'))
    await eventually(() => h.calls.length === 1, 'earlier running')
    valueOf(h.queue.enqueueCheck('queued'))

    assert.equal(h.queue.enqueueSeedChecks(['ads.md', 'wave1.md']), 4)

    assert.deepEqual(h.queue.pending(), ['ad1', 'ad2', 'w1', 'w2', 'queued'])
    for (const id of ['ad1', 'ad2', 'w1', 'w2']) {
      assert.equal(h.queue.stateOf(id), 'pending', id)
      assert.equal(statusOf(db, id), 'checking', id)
    }
    for (const id of ['hand', 'sent', 'form']) assert.equal(statusOf(db, id), 'unverified', `${id} is not checked`)
    assert.equal(statusOf(db, 'seen'), 'verified')
    const states = db.read((q) => repo.applicationsByState(q, ['draft', 'generating']).map((a) => a.id))
    assert.ok(states.includes('ad1') && states.includes('w1'), 'no CV has come back')
    await h.queue.stop()
    db.close()
  })

  test('enqueueApplicationCheck: an email application whose address was never checked (on ready/in-review); other channels have none', async () => {
    using base = tempBase()
    const db = await emptyStore(base)
    write(db, (q) => {
      addContact(q, 'c1', ADDRESSES.unverifiedNeverChecked)
      addContact(q, 'c2', ADDRESSES.unverifiedNeverChecked)
      addApp(q, 'email-app', 'c1', { state: 'in-review' })
      addApp(q, 'form-app', 'c2', { state: 'ready', channel: 'form' })
    })
    const h = harness(db)
    assert.equal(valueOf(h.queue.enqueueApplicationCheck('email-app')), 'queued')
    assert.equal(valueOf(h.queue.enqueueApplicationCheck('form-app')), 'no-check')
    errorOf(h.queue.enqueueApplicationCheck('nope'), 'not-found')
    assert.equal(statusOf(db, 'c1'), 'checking')
    assert.equal(statusOf(db, 'c2'), 'unverified')
    await h.queue.stop()
    db.close()
  })

  test('prepareTick: the 2 × batchSize next candidates with a stale or pending check; verified 15 days ago re-checks, 13 days does not', async () => {
    using base = tempBase()
    const db = await emptyStore(base)
    write(db, (q) => {
      addContact(q, 'stale15', { ...ADDRESSES.verifiedToday, checkedAt: daysAgo(15) })
      addContact(q, 'recent13', { ...ADDRESSES.verifiedToday, checkedAt: daysAgo(13) })
      addContact(q, 'never', ADDRESSES.unverifiedNeverChecked)
      addContact(q, 'beyond', ADDRESSES.unverifiedNeverChecked)
      addApp(q, 'a1', 'stale15', { state: 'ready' }, { score: 90 })
      addApp(q, 'a2', 'recent13', { state: 'ready' }, { score: 80 })
      addApp(q, 'a3', 'never', { state: 'in-review' }, { score: 70 })
      addApp(q, 'a4', 'stale15', { state: 'in-review' }, { score: 60 })
      addApp(q, 'a5', 'beyond', { state: 'in-review' }, { score: 50 })
    })
    const h = harness(db)
    assert.equal(h.queue.prepareTick({ batchSize: 2 }), 2)
    assert.equal(statusOf(db, 'stale15'), 'checking', 'T-D2 from verified')
    assert.equal(statusOf(db, 'recent13'), 'verified')
    assert.equal(statusOf(db, 'never'), 'checking')
    assert.equal(statusOf(db, 'beyond'), 'unverified', 'the fifth candidate is outside 2 × 2')
    // A candidate list from the batch (R1) wins over the default; null is an item without an address.
    assert.equal(h.queue.prepareTick({ batchSize: 1, candidates: [null, 'beyond', 'recent13'] }), 1)
    assert.equal(statusOf(db, 'beyond'), 'checking')
    await h.queue.stop()
    db.close()
  })

  test('restart: a contact that was checking (T-D6 at startup) goes back to the front and ends verified/unverified with checkedAt', async () => {
    using base = tempBase()
    const db = await emptyStore(base)
    write(db, (q) => {
      addContact(q, 'interrupted', ADDRESSES.checking)
      addContact(q, 'other', ADDRESSES.unverifiedNeverChecked)
    })
    write(db, (q) => repo.recoverOnStart(q, NOW))
    assert.equal(statusOf(db, 'interrupted'), 'unverified')
    const h = harness(db)
    valueOf(h.queue.enqueueCheck('other'))
    assert.equal(h.queue.enqueueRestarted(), 1)
    assert.equal(statusOf(db, 'interrupted'), 'checking')
    assert.deepEqual([h.queue.running(), ...h.queue.pending()], ['other', 'interrupted'])
    await eventually(() => h.calls.length === 1, 'other running')
    await answer(h, { kind: 'not-found' })
    assert.equal(h.queue.running(), 'interrupted')
    await answer(h, { kind: 'found', url: 'https://acme.example/team' })
    await eventually(() => h.queue.idle(), 'drained')
    assert.deepEqual(addressOf(db, 'interrupted'), { status: 'verified', verifiedUrl: 'https://acme.example/team', checkedAt: NOW.toISOString(), override: null })
    assert.equal(h.queue.enqueueRestarted(), 0)
    db.close()
  })

  test('a re-checked unverified address with an override keeps it: unverified (approving still works) or verified (no effect)', async () => {
    for (const [outcome, status] of [
      [{ kind: 'not-found' }, 'unverified'],
      [{ kind: 'found', url: 'https://acme.example/contact' }, 'verified'],
    ] as const) {
      using base = tempBase()
      const db = await emptyStore(base)
      write(db, (q) => addContact(q, 'c', ADDRESSES.unverifiedStaleOverride))
      const h = harness(db)
      assert.equal(valueOf(h.queue.enqueueCheck('c', { front: true })), 'queued')
      assert.deepEqual(addressOf(db, 'c')?.override, ADDRESSES.unverifiedStaleOverride.override)
      await eventually(() => h.calls.length === 1, 'c running')
      await answer(h, outcome)
      await eventually(() => h.queue.idle(), 'drained')
      const address = addressOf(db, 'c')
      assert.equal(address?.status, status)
      assert.equal(address?.checkedAt, NOW.toISOString())
      assert.deepEqual(address?.override, ADDRESSES.unverifiedStaleOverride.override)
      db.close()
    }
  })

  test('stop(): the running check is cancelled without a write (the startup write recovers it), the rest is dropped', async () => {
    using base = tempBase()
    const db = await emptyStore(base)
    write(db, (q) => {
      addContact(q, 'a', ADDRESSES.unverifiedNeverChecked)
      addContact(q, 'b', ADDRESSES.unverifiedNeverChecked)
    })
    // A search that ignores its signal and never answers.
    const h = harness(db, () => new Promise<AddressOutcome>(() => undefined))
    valueOf(h.queue.enqueueCheck('a'))
    valueOf(h.queue.enqueueCheck('b'))
    await eventually(() => h.queue.running() === 'a', 'a running')
    await h.queue.stop()
    assert.deepEqual([statusOf(db, 'a'), statusOf(db, 'b')], ['checking', 'checking'])
    assert.deepEqual(h.queue.pending(), [])
    assert.equal(h.queue.running(), null)
    assert.equal(h.timers.pending().length, 0)
    // Stopped: nothing new starts.
    write(db, (q) => addContact(q, 'c', ADDRESSES.unverifiedNeverChecked))
    errorOf(h.queue.enqueueCheck('c'), 'conflict', 'the check queue is stopped')
    assert.equal(statusOf(db, 'c'), 'unverified')
    db.close()
  })

  test('a bulk enqueue logs every contact it could not queue, and counts only the queued ones', async () => {
    using base = tempBase()
    const db = await emptyStore(base)
    write(db, (q) => {
      addContact(q, 'ok', ADDRESSES.unverifiedNeverChecked)
      repo.insertContact(q, contact(null, { id: 'bare' }), note, NOW)
    })
    const h = harness(db)
    assert.equal(h.queue.prepareTick({ batchSize: 5, candidates: ['ghost', 'ok', 'bare'] }), 1)
    const warnings = h.lines.filter((line) => line.startsWith('warn '))
    assert.deepEqual(warnings, [
      'warn address check of ghost not queued: not-found no such contact',
      'warn address check of bare not queued: conflict the contact has no address',
    ])
    await h.queue.stop()
    db.close()
  })

  test('a result whose write fails leaves the contact checking, not «done», and its next enqueue checks it again', async () => {
    using base = tempBase()
    const real = await emptyStore(base)
    write(real, (q) => addContact(q, 'a', ADDRESSES.unverifiedNeverChecked))
    let failWrites = false
    const db: Db = { ...real, tx: (fn) => (failWrites ? errorResult('module-error', 'disk I/O error') : real.tx(fn)) }
    const h = harness(db)
    valueOf(h.queue.enqueueCheck('a'))
    await eventually(() => h.calls.length === 1, 'a running')
    failWrites = true
    await answer(h, { kind: 'found', url: 'https://acme.example/contact' })
    await eventually(() => h.queue.idle(), 'drained')
    assert.equal(statusOf(real, 'a'), 'checking')
    assert.equal(h.queue.stateOf('a'), null, 'memory agrees with the store: not done')
    assert.match(h.lines.join('\n'), /warn address check of a not written: module-error disk I\/O error; still checking/)
    failWrites = false
    assert.equal(valueOf(h.queue.enqueueCheck('a')), 'queued', 'adopted again')
    await eventually(() => h.calls.length === 2, 'a running again')
    await answer(h, { kind: 'found', url: 'https://acme.example/contact' })
    await eventually(() => h.queue.idle(), 'drained again')
    assert.equal(statusOf(real, 'a'), 'verified')
    assert.equal(h.queue.stateOf('a'), 'done')
    real.close()
  })

  test('a check that throws is logged as an error, never an unhandled rejection, and the queue goes on', async () => {
    using base = tempBase()
    const db = await emptyStore(base)
    write(db, (q) => {
      addContact(q, 'a', ADDRESSES.unverifiedNeverChecked)
      addContact(q, 'b', ADDRESSES.unverifiedNeverChecked)
    })
    const timers = manualTimers()
    const hand = handSearch()
    const { log, lines } = capturedLog()
    let explode = true
    const throwingLog = { ...log, warn: (message: string) => {
      if (explode) {
        explode = false
        throw new Error('the log sink is gone')
      }
      log.warn(message)
    } }
    const queue = createCheckQueue({ db, timers: timers.timers, now: manualClock(NOW).now, search: hand.search, log: throwingLog })
    valueOf(queue.enqueueCheck('a'))
    valueOf(queue.enqueueCheck('b'))
    await eventually(() => hand.calls.length === 1, 'a running')
    write(db, (q) => q.run("UPDATE contacts SET address_status = 'verified' WHERE id = 'a'")) // its write will be refused → warn
    hand.calls[0]?.answer({ kind: 'not-found' })
    await eventually(() => hand.calls.length === 2, 'b running')
    assert.match(lines.join('\n'), /error the address-check queue failed: the log sink is gone/)
    assert.equal(queue.running(), 'b')
    assert.equal(timers.pending().length, 1, 'only b\'s deadline is armed')
    await queue.stop()
    db.close()
  })

  test('a check that cannot be written is logged, and the queue goes on', async () => {
    using base = tempBase()
    const db = await emptyStore(base)
    write(db, (q) => {
      addContact(q, 'a', ADDRESSES.unverifiedNeverChecked)
      addContact(q, 'b', ADDRESSES.unverifiedNeverChecked)
    })
    const h = harness(db)
    valueOf(h.queue.enqueueCheck('a'))
    valueOf(h.queue.enqueueCheck('b'))
    await eventually(() => h.calls.length === 1, 'a running')
    // Someone moved the row under the check (not a transition of the table): the write is refused.
    write(db, (q) => q.run("UPDATE contacts SET address_status = 'verified' WHERE id = 'a'"))
    await answer(h, { kind: 'not-found' })
    assert.equal(h.queue.running(), 'b')
    assert.match(h.lines.join('\n'), /warn address check of a not written: conflict/)
    await h.queue.stop()
    db.close()
  })
})
