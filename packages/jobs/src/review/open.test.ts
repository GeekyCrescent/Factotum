import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { insertApp, queueStore, SEED_ARTIFACTS } from '../ai/test-queue.ts'
import { instructionEvent } from '../ai/returns.ts'
import { createCheckQueue } from '../build/checks.ts'
import { addressSearch } from '../build/address.ts'
import { createNet } from '../scout/net.ts'
import { markImportedSent } from '../seed/by-hand.ts'
import { appTransition } from '../state.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { ADDRESSES, application, contact, NOW, valueOf } from '../test-state.ts'
import { capturedLog, manualClock, manualTimers, tempBase } from '../test-support.ts'
import { ok, type Application, type Profile } from '../types.ts'
import type { Batch, ReviewItemRef } from './batch.ts'
import { openReview, type OpenDeps } from './open.ts'

const TZ = 'Australia/Sydney'

function names(): () => string {
  let n = 0
  return () => `id-${(n += 1)}`
}

async function store(batchSize = 10): Promise<Db> {
  const base = tempBase()
  const db = await queueStore(base)
  valueOf(
    db.tx((q) => {
      repo.insertProfileVersion(q, { version: 2, createdAt: NOW.toISOString(), profile: { batchSize } as Profile }, { kind: 'profile-saved' }, NOW)
      return ok(undefined)
    }),
  )
  return db
}

function review(db: Db, overrides: Partial<OpenDeps> = {}) {
  const checks: string[] = []
  const opened = openReview({ db, now: () => NOW, timeZone: TZ, enqueueChecks: (ids) => void checks.push(...ids), newId: names(), log: capturedLog().log, ...overrides })
  return { ...opened, checks }
}

const apps = (batch: Batch | null): readonly string[] =>
  (batch?.items ?? []).map((item: ReviewItemRef) => (item.kind === 'application' ? item.applicationId : item.kind === 'rewritten' ? `rewritten:${item.id}${item.failed ? ':failed' : ''}` : item.kind))

function move(db: Db, id: string, event: Parameters<typeof appTransition>[1], spec: repo.EventSpec): Application {
  return valueOf(
    db.tx((q) => {
      const app = repo.getApplication(q, id)
      if (app === undefined) return ok(undefined as unknown as Application)
      const moved = appTransition(app, event, NOW)
      if (!moved.ok) return moved
      const saved = repo.saveApplication(q, moved.value, spec, NOW)
      return saved.ok ? ok(moved.value) : saved
    }),
  )
}

describe('startBatch and batch (R1)', () => {
  test('the batch is kept with its cursor: another reader gets the same one', async () => {
    const db = await store()
    insertApp(db, { id: 'a1', state: 'ready' })
    insertApp(db, { id: 'a2', state: 'draft' })
    const first = review(db)
    const started = valueOf(first.startBatch())
    assert.deepEqual(apps(started), ['a1'])
    assert.equal(started.cursor, 0)
    db.tx((q) => {
      repo.saveBatch(q, { ...(started as unknown as repo.StoredBatch), cursor: 1 })
      return ok(undefined)
    })
    const again = valueOf(review(db).batch())
    assert.equal(again?.id, started.id)
    assert.equal(again?.cursor, 1)
    assert.deepEqual(again?.items, started.items)
  })

  test('no batch open: null; a new start closes the old one', async () => {
    const db = await store()
    insertApp(db, { id: 'a1', state: 'ready' })
    const r = review(db)
    assert.equal(valueOf(r.batch()), null)
    const one = valueOf(r.startBatch())
    const two = valueOf(r.startBatch())
    assert.notEqual(one.id, two.id)
    assert.equal(valueOf(r.batch())?.id, two.id)
  })

  test('without a profile there is no batch size: conflict', async () => {
    const base = tempBase()
    const opened = await (await import('../store/db.ts')).openDb({ dir: base.dir, now: () => NOW })
    const db = valueOf(opened)
    const result = review(db).startBatch()
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.reason, 'no-profile')
  })

  test('the batch size comes from the profile', async () => {
    const db = await store(2)
    for (const id of ['a1', 'a2', 'a3']) insertApp(db, { id, state: 'in-review' })
    assert.equal(valueOf(review(db).startBatch()).items.length, 2)
  })

  test('an application that leaves a batch state (B5: approved and sent) leaves the open batch', async () => {
    const db = await store()
    insertApp(db, { id: 'a1', state: 'ready', channel: 'form' })
    insertApp(db, { id: 'a2', state: 'ready' })
    const r = review(db)
    valueOf(r.startBatch())
    move(db, 'a1', { type: 'approve', pdfExists: true, address: null, sendAnyway: false, cap: { sentToday: 0, maxPerDay: 40 }, messageId: '<m@x>', profileVersion: 1 }, { kind: 'approved' })
    move(db, 'a1', { type: 'mark-sent' }, { kind: 'sent' })
    assert.deepEqual(apps(valueOf(r.batch())), ['a2'])
  })

  test('S6b: an application of the open batch that the reimport marks sent leaves it', async () => {
    const db = await store()
    valueOf(
      db.tx((q) => {
        repo.insertApplication(q, application({ id: 'seeded', state: 'ready' }), { seedKey: '02-anuncios.md#3' }, { kind: 'imported' }, NOW)
        repo.insertArtifacts(q, 'seeded', SEED_ARTIFACTS, NOW)
        return ok(undefined)
      }),
    )
    insertApp(db, { id: 'a2', state: 'ready' })
    const r = review(db)
    assert.deepEqual(apps(valueOf(r.startBatch())), ['seeded', 'a2'])
    valueOf(markImportedSent(db, '02-anuncios.md#3', '2026-11-12T01:00:00.000Z', NOW))
    assert.deepEqual(apps(valueOf(r.batch())), ['a2'])
  })

  test('a decided item stays when its entity leaves (crit. 35: «← Back» shows it)', async () => {
    const db = await store()
    insertApp(db, { id: 'a1', state: 'ready', channel: 'form' })
    const r = review(db)
    const started = valueOf(r.startBatch())
    const itemId = started.items[0]?.itemId ?? ''
    db.tx((q) => {
      repo.saveBatch(q, { ...(started as unknown as repo.StoredBatch), results: { [itemId]: 'approved' } })
      return ok(undefined)
    })
    move(db, 'a1', { type: 'approve', pdfExists: true, address: null, sendAnyway: false, cap: { sentToday: 0, maxPerDay: 40 }, messageId: '<m@x>', profileVersion: 1 }, { kind: 'approved' })
    assert.deepEqual(apps(valueOf(r.batch())), ['a1'])
  })

  test('the test application never enters a normal batch, and while in review the batch is only it (a B3 row)', async () => {
    const db = await store()
    insertApp(db, { id: 'a1', state: 'ready' })
    insertApp(db, { id: 'test-app', state: 'in-review', test: true })
    const r = review(db)
    assert.deepEqual(apps(valueOf(r.startBatch())), ['test-app'])
    move(db, 'test-app', { type: 'close', reason: 'done testing' }, { kind: 'closed' })
    assert.deepEqual(apps(valueOf(r.startBatch())), ['a1'])
  })

  test('a rewrite that comes back is appended at the end, and so is one that failed (A4)', async () => {
    const db = await store()
    insertApp(db, { id: 'a1', state: 'ready' })
    insertApp(db, { id: 'a2', state: 'in-review' })
    insertApp(db, { id: 'a3', state: 'ready' })
    const r = review(db)
    assert.deepEqual(apps(valueOf(r.startBatch())), ['a1', 'a3', 'a2'])
    move(db, 'a1', { type: 'instruction', hasLetter: true }, instructionEvent('shorter'))
    move(db, 'a2', { type: 'instruction', hasLetter: true }, instructionEvent('warmer'))
    assert.deepEqual(apps(valueOf(r.batch())), ['a3'], 'rewriting is not a batch state')
    move(db, 'a1', { type: 'rewrite-returned', pdfExists: true, warnings: [], version: 2 }, { kind: 'rewritten', data: { version: 2 } })
    move(db, 'a2', { type: 'rewrite-failed' }, { kind: 'rewrite-failed', data: { instruction: 'warmer' } })
    const after = valueOf(r.batch())
    assert.deepEqual(apps(after), ['a3', 'rewritten:a1', 'rewritten:a2:failed'])
    assert.deepEqual(apps(valueOf(r.batch())), apps(after), 'appended once')
  })

  test('a rewrite that came back and nobody decided heads the next batch', async () => {
    const db = await store()
    insertApp(db, { id: 'a1', state: 'ready' })
    insertApp(db, { id: 'a2', state: 'ready' })
    move(db, 'a2', { type: 'instruction', hasLetter: true }, instructionEvent('shorter'))
    move(db, 'a2', { type: 'rewrite-returned', pdfExists: true, warnings: [], version: 2 }, { kind: 'rewritten', data: { version: 2 } })
    assert.deepEqual(apps(valueOf(review(db).startBatch())), ['rewritten:a2', 'a1'])
  })
})

describe('what the batch cannot read as written', () => {
  test('a skip with a malformed instant does not break startBatch, and is logged once', async () => {
    const db = await store()
    insertApp(db, { id: 'a1', state: 'ready' })
    db.tx((q) => {
      repo.appendEvent(q, { kind: 'skipped', data: { reason: 'not-now' }, applicationId: 'a1', companyId: 'company-1', at: 'not a date' }, NOW)
      return ok(undefined)
    })
    const log = capturedLog()
    const r = review(db, { log: log.log })
    assert.deepEqual(apps(valueOf(r.startBatch())), ['a1'])
    assert.deepEqual(log.lines, ['warn jobs review: a skipped event of a1 has a malformed instant'])
  })
})

describe('a reply (asks-something) in the open batch', () => {
  test('it leaves the open batch once it is marked done elsewhere (note { replyEventId })', async () => {
    const db = await store()
    insertApp(db, { id: 'a1', state: 'sent' })
    insertApp(db, { id: 'a2', state: 'ready' })
    const replyId = valueOf(
      db.tx((q) => {
        const event = repo.appendEvent(q, { kind: 'reply', data: { class: 'asks-something' }, applicationId: 'a1', companyId: 'company-1' }, NOW)
        return ok(event.id)
      }),
    )
    const r = review(db)
    assert.deepEqual(apps(valueOf(r.startBatch())), ['reply', 'a2'])
    db.tx((q) => {
      repo.appendEvent(q, { kind: 'note', data: { replyEventId: replyId }, applicationId: 'a1', companyId: 'company-1' }, NOW)
      return ok(undefined)
    })
    assert.deepEqual(apps(valueOf(r.batch())), ['a2'])
  })
})

describe('startBatch does not wait for the network (crit. 46b)', () => {
  test('with a fetch that never answers it returns at once, and the unchecked address is checked in front', async () => {
    const db = await store()
    valueOf(
      db.tx((q) => {
        repo.insertContact(q, contact(ADDRESSES.unverifiedNeverChecked, { id: 'contact-2', email: 'bo@acme.example' }), { kind: 'imported' }, NOW)
        repo.insertContact(q, contact(ADDRESSES.verifiedStale, { id: 'contact-3', email: 'cy@acme.example' }), { kind: 'imported' }, NOW)
        return ok(undefined)
      }),
    )
    insertApp(db, { id: 'a1', state: 'ready', target: { ...application().target, contactId: 'contact-1' } })
    insertApp(db, { id: 'a2', state: 'ready', target: { ...application().target, contactId: 'contact-2' } })
    insertApp(db, { id: 'a3', state: 'ready', target: { ...application().target, contactId: 'contact-3' } })
    const timers = manualTimers()
    const clock = manualClock(NOW)
    let fetches = 0
    const net = createNet({
      fetch: () => {
        fetches += 1
        return new Promise<Response>(() => undefined)
      },
      lookup: async () => ['93.184.216.34'],
      timers: timers.timers,
      now: clock.now,
      politeMs: 0,
    })
    const checks = createCheckQueue({ db, timers: timers.timers, now: clock.now, search: addressSearch(net), log: capturedLog().log })
    const r = review(db, { enqueueChecks: (ids) => checks.enqueueContacts(ids, { front: true }) })
    const started = Date.now()
    const batch = valueOf(r.startBatch())
    assert.ok(Date.now() - started < 1_000)
    assert.deepEqual(apps(batch), ['a1', 'a2', 'a3'])
    assert.equal(checks.running(), 'contact-2', 'the first unchecked item is checked first')
    assert.deepEqual(checks.pending(), ['contact-3'])
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(fetches <= 1)
    await checks.stop()
  })

  test('a check queue that throws after the batch is written: the batch is still answered, and the fault logged', async () => {
    const db = await store()
    valueOf(
      db.tx((q) => {
        repo.insertContact(q, contact(ADDRESSES.checking, { id: 'contact-2', email: 'bo@acme.example' }), { kind: 'imported' }, NOW)
        return ok(undefined)
      }),
    )
    insertApp(db, { id: 'a1', state: 'ready', target: { ...application().target, contactId: 'contact-2' } })
    const log = capturedLog()
    const r = review(db, {
      log: log.log,
      enqueueChecks: () => {
        throw new Error('check queue stopped')
      },
    })
    const batch = valueOf(r.startBatch())
    assert.deepEqual(apps(batch), ['a1'])
    assert.ok(log.lines.some((line) => line.startsWith('error') && line.includes('check queue stopped')))
  })

  test('only email items with a due check are queued, each contact once', async () => {
    const db = await store()
    valueOf(
      db.tx((q) => {
        repo.insertContact(q, contact(ADDRESSES.checking, { id: 'contact-2', email: 'bo@acme.example' }), { kind: 'imported' }, NOW)
        return ok(undefined)
      }),
    )
    const target = { ...application().target, contactId: 'contact-2' }
    insertApp(db, { id: 'a1', state: 'ready', target })
    insertApp(db, { id: 'a2', state: 'ready', target })
    insertApp(db, { id: 'a3', state: 'ready', channel: 'form', target })
    insertApp(db, { id: 'a4', state: 'ready' })
    const r = review(db)
    valueOf(r.startBatch())
    assert.deepEqual(r.checks, ['contact-2'])
  })
})
