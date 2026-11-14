import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { NotificationMessage } from '@factotum/core'
import { appOf, insertApp, queueStore } from '../ai/test-queue.ts'
import { appTransition } from '../state.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { NOW, send, valueOf } from '../test-state.ts'
import { tempBase } from '../test-support.ts'
import { applyReply } from './apply.ts'
import { applyDeferredWithPush } from './deferred-push.ts'
import type { ReplyClass } from './match.ts'

const M1 = '<m1@jobs.factotum.local>'

async function sending(base: { dir: string }): Promise<Db> {
  const db = await queueStore({ dir: base.dir, [Symbol.dispose]: () => undefined })
  insertApp(db, { id: 'app-1', state: 'sending', sends: [send({ state: 'sending' })] })
  return db
}

function deferred(db: Db, cls: ReplyClass, uid: number): void {
  const reply = {
    key: `7:${uid}`,
    uidValidity: 7,
    uid,
    messageId: `<r${uid}@acme.example>`,
    from: 'Ada <ada@acme.example>',
    fromAddress: 'ada@acme.example',
    subject: 'Re: Application',
    date: NOW.toISOString(),
    receivedAt: NOW.toISOString(),
    gmailLink: null,
    list: false,
    match: { kind: 'thread', rule: 1, applicationId: 'app-1', sendKind: 'initial', viaAttempt: false, messageId: M1 },
    body: '',
  } as const
  valueOf(db.tx((q) => applyReply(q, { reply, input: { from: '', subject: '', body: '', candidates: [] } }, { class: cls, applicationId: null, summary: 's' }, NOW, { push: () => assert.fail('no push while sending') })))
}

/** Step 3 of the send (T-S2) and the deferred replies, in one `tx` here. */
function accepted(db: Db, pushes: NotificationMessage[]): void {
  const apply = applyDeferredWithPush((_key, message) => pushes.push(message))
  valueOf(
    db.tx((q) => {
      valueOf(repo.saveApplication(q, valueOf(appTransition(appOf(db, 'app-1'), { type: 'smtp-accepted', response: '250 OK' }, NOW)), { kind: 'sent' }, NOW))
      return apply(q, 'app-1', NOW)
    }),
  )
}

test('Q4 (v6.1): a deferred interview pushes when the close of the send applies it — once', async () => {
  using base = tempBase()
  const db = await sending(base)
  deferred(db, 'interview', 11)
  const pushes: NotificationMessage[] = []

  accepted(db, pushes)

  assert.deepEqual(pushes, [{ title: 'Interview: Acme', body: 'Tap to open.', path: '/m/jobs/a/app-1', tag: 'jobs-reply-app-1' }])
  assert.equal(appOf(db, 'app-1').state, 'replied')
  valueOf(db.tx((q) => applyDeferredWithPush((_key, message) => pushes.push(message))(q, 'app-1', NOW)))
  assert.equal(pushes.length, 1, 'applied already: nothing again')
})

test('Q4 (v6.1): a deferred auto-ack applies without a push', async () => {
  using base = tempBase()
  const db = await sending(base)
  deferred(db, 'auto-ack', 12)
  const pushes: NotificationMessage[] = []
  accepted(db, pushes)
  assert.deepEqual([pushes.length, appOf(db, 'app-1').state], [0, 'sent'])
})
