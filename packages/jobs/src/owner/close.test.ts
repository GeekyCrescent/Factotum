import assert from 'node:assert/strict'
import { test } from 'node:test'

import { appOf, eventsOf, insertApp, queueStore } from '../ai/test-queue.ts'
import { NOW, errorOf, send, valueOf } from '../test-state.ts'
import { tempBase } from '../test-support.ts'
import { closeApplication } from './close.ts'

const ctx = { now: () => NOW }

test('C1 close: «Close» with a reason takes a ready application to closed, dropped (T-A26)', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  insertApp(db, { state: 'ready' })

  const closed = valueOf(closeApplication(db, ctx, 'app-1', { reason: 'filled elsewhere' }))

  assert.equal(closed.state, 'closed')
  assert.equal(closed.outcome, 'dropped')
  assert.equal(appOf(db, 'app-1').state, 'closed')
  const event = eventsOf(db, 'app-1').find((e) => e.kind === 'closed')
  assert.deepEqual(event?.data, { reason: 'filled elsewhere', outcome: 'dropped', from: 'ready' })
})

test('C1 close: a sent application closes too (T-A21)', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  insertApp(db, { state: 'sent', sends: [send({ state: 'sent' })] })

  assert.equal(valueOf(closeApplication(db, ctx, 'app-1', { reason: 'no answer' })).state, 'closed')
})

test('C1 close: no reason, a blank one or one too long is invalid; an unknown id not-found; sending is refused', async () => {
  using base = tempBase()
  const db = await queueStore(base)
  insertApp(db, { state: 'ready' })
  insertApp(db, { id: 'busy', state: 'sending', sends: [send()] })

  errorOf(closeApplication(db, ctx, 'app-1', {} as { reason: string }), 'invalid')
  errorOf(closeApplication(db, ctx, 'app-1', { reason: '   ' }), 'invalid')
  errorOf(closeApplication(db, ctx, 'app-1', { reason: 'x'.repeat(201) }), 'invalid')
  errorOf(closeApplication(db, ctx, 'nope', { reason: 'r' }), 'not-found')
  errorOf(closeApplication(db, ctx, 'busy', { reason: 'r' }), 'conflict')
  assert.equal(appOf(db, 'app-1').state, 'ready', 'nothing was written')
})
