/**
 * E1b — approving does not wait for SMTP (design D9 steps 4–5). (R7, R38b, R41)
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { SEND_DEADLINE_MS } from '@factotum/mail'

import * as repo from '../store/repo.ts'
import { valueOf, errorOf } from '../test-state.ts'
import { eventually } from '../test-support.ts'
import { appOf, eventsOf, world, write, type World, type WorldOptions } from '../test-send.ts'
import { createSender } from './send.ts'

async function within(t: { skip: (m: string) => void }, options: WorldOptions, body: (w: World) => Promise<void>): Promise<void> {
  const w = await world(options)
  if (w === null) return t.skip('openssl is not installed: the send tests need it for a throwaway CA')
  try {
    await body(w)
  } finally {
    await w.close()
  }
}

const kindsOf = (w: World): readonly string[] => eventsOf(w.db).map((e) => e.kind)
const armed = (w: World) => eventually(() => w.timers.pending().includes(SEND_DEADLINE_MS), 'the 40 s deadline armed')

describe('approve does not wait for SMTP (E1b)', () => {
  test('with a server that never answers, approve returns { ok, sending } without the clock moving', async (t) => {
    await within(t, { cut: { at: 'greeting', how: 'silent' } }, async (w) => {
      const sender = createSender(w.deps)
      const before = w.clock.now().getTime()
      assert.deepEqual(valueOf(sender.approve('app-1', 'initial')), { state: 'sending', kind: 'initial' })
      assert.equal(w.clock.now().getTime(), before)
      assert.equal(valueOf(sender.send('app-1', 'initial')).state, 'sending')
      await armed(w)
      w.timers.fire(SEND_DEADLINE_MS)
      await sender.settled()
    })
  })

  test('at 40 s of the fake clock (SEND_DEADLINE_MS): failed when DATA never went, send-unknown after it', async (t) => {
    for (const [cut, expected] of [
      [{ at: 'greeting', how: 'silent' }, 'failed'],
      [{ at: 'message', how: 'silent' }, 'send-unknown'],
    ] as const) {
      await within(t, { cut }, async (w) => {
        const sender = createSender(w.deps)
        valueOf(sender.approve('app-1', 'initial'))
        await armed(w)
        if (cut.at === 'message') await eventually(() => w.server.messages.length === 1, 'the body went out')
        w.timers.fire(SEND_DEADLINE_MS)
        await sender.settled()
        assert.equal(appOf(w.db).sends[0]?.state, expected)
        assert.equal(appOf(w.db).state, expected === 'failed' ? 'ready' : 'send-unknown')
      })
    }
  })

  test('stop() mid-send aborts SMTP and does NOT run step 3 — also before DATA: no failed, no send-failed; the next start makes it send-unknown', async (t) => {
    for (const cut of [
      { at: 'greeting', how: 'silent' },
      { at: 'message', how: 'silent' },
    ] as const) {
      await within(t, { cut }, async (w) => {
        const sender = createSender(w.deps)
        valueOf(sender.approve('app-1', 'initial'))
        await armed(w)
        if (cut.at === 'message') await eventually(() => w.server.messages.length === 1, 'the body went out')
        await sender.stop()
        const app = appOf(w.db)
        assert.equal(app.state, 'sending')
        assert.equal(app.sends[0]?.state, 'sending')
        assert.ok(!kindsOf(w).includes('send-failed'))
        assert.ok(!kindsOf(w).includes('send-unknown'))
        assert.ok(!kindsOf(w).includes('sent'))
        // Aborted: the deadline timer is gone, nothing left in flight.
        assert.deepEqual(w.timers.pending(), [])
        write(w.db, (q) => repo.recoverOnStart(q, w.clock.now()))
        assert.equal(appOf(w.db).sends[0]?.state, 'send-unknown')
        assert.equal(appOf(w.db).state, 'send-unknown')
      })
    }
  })

  test('after stop(), approve is refused and nothing launches; launch says so', async (t) => {
    await within(t, {}, async (w) => {
      const sender = createSender(w.deps)
      await sender.stop()
      errorOf(sender.approve('app-1', 'initial'), 'conflict')
      assert.equal(sender.launch('app-1', 'initial'), false)
      await sender.settled()
      assert.equal(appOf(w.db).state, 'ready')
      assert.equal(w.server.commands.length, 0)
      assert.match(w.lines.join('\n'), /warn send app-1\/initial: not launched, the sender is stopping/)
    })
  })

  test('SMTP accepts while stop() aborts: step 3 is still not written (D9 step 5), but the log keeps the messageId and the response', async (t) => {
    await within(t, {}, async (w) => {
      let called = false
      const sender = createSender({
        ...w.deps,
        // The 250 arrives as the abort does: the server already has the mail.
        sendMail: (input) => {
          called = true
          return new Promise((resolve) => input.signal.addEventListener('abort', () => resolve({ ok: true, messageId: input.messageId, response: '250 2.0.0 OK q1 - gsmtp' })))
        },
      })
      valueOf(sender.approve('app-1', 'initial'))
      const messageId = appOf(w.db).sends[0]?.messageId ?? ''
      await eventually(() => called, 'sendMail is called')
      await sender.stop()
      assert.equal(appOf(w.db).sends[0]?.state, 'sending')
      assert.ok(!kindsOf(w).includes('sent'))
      const logged = w.lines.join('\n')
      assert.ok(logged.includes(messageId), logged)
      assert.match(logged, /accepted by SMTP after stop/)
      assert.match(logged, /250 2\.0\.0 OK q1/)
      for (const secret of ['ada@acme.example', 'Dear Ada', 'abcdefghijklmnop']) assert.ok(!logged.includes(secret), `no ${secret} in the log`)
    })
  })
})
