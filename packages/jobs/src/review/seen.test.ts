import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { insertApp, insertFollowup, queueStore } from '../ai/test-queue.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { ADDRESSES, contact, NOW, valueOf } from '../test-state.ts'
import { tempBase } from '../test-support.ts'
import { fail, type Warning } from '../types.ts'
import type { Batch, ReviewItemRef } from './batch.ts'
import { seenOf, withSeen } from './seen.ts'

const CLAIM: Warning = { code: 'unsupported-claim', where: 'cv', detail: 'claim 1', blocks: true, overridden: null }
const item: ReviewItemRef = { itemId: 'i1', kind: 'application', applicationId: 'a1' }
const seen = (db: Db, ref: ReviewItemRef = item): string => db.read((q) => seenOf(q, ref))

function change(db: Db, edit: (app: NonNullable<ReturnType<typeof repo.getApplication>>) => Parameters<typeof repo.saveApplication>[1]): void {
  valueOf(
    db.tx((q) => {
      const app = repo.getApplication(q, 'a1')
      if (app === undefined) return fail('not-found', 'a1')
      return repo.saveApplication(q, edit(app), { kind: 'note', data: {} }, NOW)
    }),
  )
}

describe('seen: the fingerprint of what the card shows (D15 «Lo que se vio es lo que se aprueba»)', () => {
  test('the same state gives the same seen, read after read', async () => {
    const db = await queueStore(tempBase())
    insertApp(db, { id: 'a1', state: 'in-review', warnings: [CLAIM] })
    assert.equal(seen(db), seen(db))
    assert.match(seen(db), /^[0-9a-f]{64}$/)
  })

  test('a new version, a warning overridden, a channel or an address that changed: another seen', async () => {
    const db = await queueStore(tempBase())
    insertApp(db, { id: 'a1', state: 'in-review', warnings: [CLAIM] })
    const before = seen(db)
    change(db, (app) => ({ ...app, version: app.version + 1 }))
    const afterVersion = seen(db)
    assert.notEqual(afterVersion, before)
    change(db, (app) => ({ ...app, warnings: [{ ...CLAIM, overridden: { at: NOW.toISOString() } }] }))
    const afterOverride = seen(db)
    assert.notEqual(afterOverride, afterVersion)
    change(db, (app) => ({ ...app, channel: 'form', target: { ...app.target, url: 'https://acme.example/jobs/1' } }))
    const afterChannel = seen(db)
    assert.notEqual(afterChannel, afterOverride)
    change(db, (app) => ({ ...app, channel: 'email', target: { ...app.target, contactId: 'contact-1' } }))
    const withContact = seen(db)
    valueOf(
      db.tx((q) => {
        const old = repo.getContact(q, 'contact-1')
        if (old === undefined) return fail('not-found', 'contact-1')
        return repo.saveContact(q, contact(ADDRESSES.unverifiedNeverChecked, { id: 'contact-1' }), { kind: 'note', data: {} }, NOW)
      }),
    )
    assert.notEqual(seen(db), withContact, 'the address state is part of what is seen')
  })

  test('a follow-up, a reply and an entity that is gone each have a seen', async () => {
    const db = await queueStore(tempBase())
    insertApp(db, { id: 'a1', state: 'sent' })
    insertFollowup(db, { id: 'fu-1', applicationId: 'a1', state: 'ready' })
    const fu: ReviewItemRef = { itemId: 'i2', kind: 'followup', followupId: 'fu-1' }
    const reply: ReviewItemRef = { itemId: 'i3', kind: 'reply', applicationId: 'a1', eventId: 'e1' }
    const gone: ReviewItemRef = { itemId: 'i4', kind: 'application', applicationId: 'nobody' }
    const all = [seen(db, fu), seen(db, reply), seen(db, gone)]
    assert.equal(new Set(all).size, 3)
  })

  test('withSeen puts each item’s seen on it, nothing else changed', async () => {
    const db = await queueStore(tempBase())
    insertApp(db, { id: 'a1', state: 'ready' })
    const batch: Batch = { id: 'b1', items: [item], cursor: 0, results: {} }
    const view = db.read((q) => withSeen(q, batch))
    assert.deepEqual(view, { ...batch, items: [{ ...item, seen: seen(db) }] })
    const [shown] = view.items
    if (shown !== undefined) assert.equal(seen(db, shown), shown.seen, 'an item that carries its seen has the same fingerprint')
  })
})
