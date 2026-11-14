/**
 * E1 — the three steps of design D9 on the `sends(kind)` row, against the made-up SMTP server.
 * (R11, R21, R38, R39, R40, R41, R58)
 */

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { describe, test } from 'node:test'

import * as repo from '../store/repo.ts'
import { followup, followupVersion, valueOf, errorOf } from '../test-state.ts'
import { appOf, BODY, decoded, eventsOf, PHONE, SUBJECT, sentWithFollowup, world, write, type World, type WorldOptions } from '../test-send.ts'
import { applyDeferredRepliesOnStart } from './deferred.ts'
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

const SIGNATURE = `Ada Applicant · ada.applicant@example.com · ${PHONE}`
const kindsOf = (w: World): readonly string[] => eventsOf(w.db).map((e) => e.kind)

describe('send: the three steps of D9 (E1)', () => {
  test('initial: tx → sending with a Message-ID, SMTP outside, tx → sent with the response; one `sent` event without the body', async (t) => {
    await within(t, {}, async (w) => {
      const sender = createSender(w.deps)
      assert.deepEqual(valueOf(sender.approve('app-1', 'initial')), { state: 'sending', kind: 'initial' })
      // Step 1 is written before SMTP is opened.
      const sending = appOf(w.db)
      assert.equal(sending.state, 'sending')
      const row = sending.sends[0]
      assert.equal(row?.state, 'sending')
      assert.match(row?.messageId ?? '', /^<[0-9a-f-]{36}@jobs\.factotum\.local>$/)
      assert.equal(row?.profileVersion, 1)

      await sender.settled()
      const sent = appOf(w.db)
      assert.equal(sent.state, 'sent')
      assert.equal(sent.sends[0]?.state, 'sent')
      assert.match(sent.sends[0]?.response ?? '', /^250 2\.0\.0 OK/)
      assert.equal(w.server.messages.length, 1)
      const message = w.server.messages[0] ?? ''
      assert.ok(message.includes(`Message-ID: ${row?.messageId}`), 'our Message-ID goes out')
      assert.ok(message.includes('application/pdf'), 'the initial carries the CV')

      const sentEvents = eventsOf(w.db).filter((e) => e.kind === 'sent')
      assert.equal(sentEvents.length, 1)
      assert.deepEqual(sentEvents[0]?.data, { kind: 'initial', messageId: row?.messageId, response: sent.sends[0]?.response, addressOverride: false })
      assert.deepEqual(kindsOf(w).slice(-2), ['approved', 'sent'])
      const all = JSON.stringify(eventsOf(w.db))
      for (const secret of ['Dear Ada', SUBJECT, 'ada@acme.example', PHONE]) assert.ok(!all.includes(secret), `no ${secret} in an event`)
      assert.ok(!w.lines.join('\n').includes('ada@acme.example'), 'no address in the log')
    })
  })

  test('the signature is put in when sending: the stored text keeps {signature}, the mail has the phone, profile_version is recorded', async (t) => {
    await within(t, {}, async (w) => {
      const sender = createSender(w.deps)
      valueOf(sender.approve('app-1', 'initial'))
      await sender.settled()
      const stored = w.db.read((q) => repo.getArtifacts(q, 'app-1', 1))
      assert.equal(stored?.letter?.body, BODY, 'the stored letter is not filled')
      assert.ok(decoded(w.server.messages[0] ?? '').includes(SIGNATURE), 'the mail carries the signature with the phone')
      assert.equal(appOf(w.db).sends[0]?.profileVersion, 1)
    })
  })

  test('the signature comes from the profile version recorded at step 1, and a newer one is recorded when approving after it', async (t) => {
    await within(t, {}, async (w) => {
      const newer = { version: 2, createdAt: '2026-11-14T00:00:00.000Z', profile: { ...(await import('../test-send.ts')).testProfile('+61 400 000 002') } }
      write(w.db, (q) => repo.insertProfileVersion(q, newer, { kind: 'profile-saved' }, w.clock.now()))
      const sender = createSender(w.deps)
      valueOf(sender.approve('app-1', 'initial'))
      await sender.settled()
      assert.equal(appOf(w.db).sends[0]?.profileVersion, 2)
      assert.ok(decoded(w.server.messages[0] ?? '').includes('+61 400 000 002'))
    })
  })

  test('step 1 with the current PDF deleted from the disk → blocked missing-cv, no row in sends', async (t) => {
    await within(t, { noPdf: true }, async (w) => {
      const sender = createSender(w.deps)
      errorOf(sender.approve('app-1', 'initial'), 'blocked', 'missing-cv')
      const app = appOf(w.db)
      assert.equal(app.state, 'ready')
      assert.deepEqual(app.sends, [])
      await sender.settled()
      assert.equal(w.server.commands.length, 0, 'SMTP never opened')
    })
  })

  test('before-data → failed with the reason, the application back to ready, `send-failed`; never retried alone', async (t) => {
    await within(t, { cut: { at: 'RCPT TO', how: '550 5.1.1 The email account that you tried to reach does not exist.' } }, async (w) => {
      const sender = createSender(w.deps)
      valueOf(sender.approve('app-1', 'initial'))
      await sender.settled()
      const app = appOf(w.db)
      assert.equal(app.state, 'ready')
      assert.equal(app.sends[0]?.state, 'failed')
      assert.ok((app.sends[0]?.reason ?? '') !== '')
      const failed = eventsOf(w.db).filter((e) => e.kind === 'send-failed')
      assert.equal(failed.length, 1)
      assert.equal(failed[0]?.data.kind, 'initial')
      // Never again by itself: one connection, nothing pending.
      w.timers.fire()
      await sender.settled()
      assert.equal(w.server.commands.filter((c) => c === 'EHLO').length, 1)
      assert.equal(eventsOf(w.db).filter((e) => e.kind === 'approved').length, 1)
    })
  })

  test('after-data → send-unknown, `send-unknown { kind }`', async (t) => {
    await within(t, { cut: { at: 'message', how: 'close' } }, async (w) => {
      const sender = createSender(w.deps)
      valueOf(sender.approve('app-1', 'initial'))
      await sender.settled()
      const app = appOf(w.db)
      assert.equal(app.state, 'send-unknown')
      assert.equal(app.sends[0]?.state, 'send-unknown')
      assert.deepEqual(eventsOf(w.db).filter((e) => e.kind === 'send-unknown').map((e) => e.data), [{ kind: 'initial' }])
    })
  })

  test('a password file that does not read → failed before SMTP, with the file reason and never its content', async (t) => {
    await within(t, {}, async (w) => {
      rmSync(w.passwordFile)
      const sender = createSender(w.deps)
      valueOf(sender.approve('app-1', 'initial'))
      await sender.settled()
      const app = appOf(w.db)
      assert.equal(app.sends[0]?.state, 'failed')
      assert.match(app.sends[0]?.reason ?? '', /password file unreadable/)
      assert.equal(w.server.commands.length, 0)
    })
  })

  test('a slot left unfilled at sending → failed with the slot, nothing goes out', async (t) => {
    await within(t, { letter: { subject: SUBJECT, body: 'Hi\n\n{portfolio}\n\n{signature}' } }, async (w) => {
      const profile = { ...(await import('../test-send.ts')).testProfile() }
      const empty = { ...profile, identity: { ...profile.identity, portfolioUrl: '' } }
      write(w.db, (q) => repo.insertProfileVersion(q, { version: 2, createdAt: '2026-11-14T00:00:00.000Z', profile: empty }, { kind: 'profile-saved' }, w.clock.now()))
      const sender = createSender(w.deps)
      valueOf(sender.approve('app-1', 'initial'))
      await sender.settled()
      assert.equal(appOf(w.db).sends[0]?.state, 'failed')
      assert.equal(appOf(w.db).sends[0]?.reason, 'unfilled-slot: portfolio')
      assert.equal(w.server.messages.length, 0)
    })
  })

  test('followup-1: inReplyTo/references from sends, NO attachment even with the initial PDF deleted; the application stays sent and its follow-up row goes ready → sending → sent (T-F6, T-F8)', async (t) => {
    await within(t, {}, async (w) => {
      const fu = followup({ versions: [followupVersion(1, { subject: null, body: 'Hi Ada,\n\nFollowing up.\n\n{signature}' })] })
      write(w.db, (q) => sentWithFollowup(q, fu))
      rmSync(w.pdf)
      const sender = createSender(w.deps)
      assert.deepEqual(valueOf(sender.approve('app-1', 'followup-1')), { state: 'sending', kind: 'followup-1' })
      assert.equal(w.db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, 'sending')
      assert.equal(appOf(w.db).sends.find((s) => s.kind === 'followup-1')?.followupId, 'fu-1')
      await sender.settled()

      const app = appOf(w.db)
      assert.equal(app.state, 'sent')
      assert.equal(app.sends.find((s) => s.kind === 'followup-1')?.state, 'sent')
      assert.equal(app.sends.find((s) => s.kind === 'initial')?.state, 'sent')
      assert.equal(w.db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, 'sent')
      const message = w.server.messages[0] ?? ''
      assert.ok(!message.includes('application/pdf'), 'a follow-up never carries the CV')
      assert.ok(message.includes('In-Reply-To: <initial@jobs.factotum.local>'))
      assert.ok(message.includes('References: <initial@jobs.factotum.local>'))
      assert.equal(w.inputs[0]?.subject, `Re: ${SUBJECT}`, 'in the thread: Re: <the initial subject>')
      assert.equal(w.inputs[0]?.attachment, undefined)
      assert.ok(decoded(message).includes(SIGNATURE))
      const sent = eventsOf(w.db).filter((e) => e.kind === 'sent')
      assert.equal(sent.length, 1)
      assert.equal(sent[0]?.data.kind, 'followup-1')
      assert.equal(sent[0]?.data.followupId, 'fu-1')
    })
  })

  test('deferred reply: `reply { deferred: true, class: interview }` while the initial is sending, before-data → replied, not ready (T-S3 → T-S11 + T-A30)', async (t) => {
    await within(t, { cut: { at: 'MAIL FROM', how: '550 5.7.1 Refused' } }, async (w) => {
      const sender = createSender(w.deps)
      valueOf(sender.approve('app-1', 'initial'))
      const reply = write(w.db, (q) =>
        repo.appendEvent(q, { kind: 'reply', applicationId: 'app-1', companyId: 'company-1', data: { deferred: true, class: 'interview' } }, w.clock.now()),
      )
      await sender.settled()
      const app = appOf(w.db)
      assert.equal(app.state, 'replied')
      assert.equal(app.outcome, 'interview')
      assert.equal(app.sends[0]?.state, 'sent')
      const applied = eventsOf(w.db).filter((e) => e.kind === 'reply-applied')
      assert.deepEqual(applied.map((e) => e.data.replyEventId), [reply.id])
      assert.ok(kindsOf(w).includes('resolved-by-reply'))
    })
  })

  test('deferred reply after SMTP accepted (T-S2 → the class) and after a cut past DATA (T-S4 → T-S7 + T-A17)', async (t) => {
    for (const [cut, kind] of [
      [undefined, 'rejection'],
      [{ at: 'message', how: 'close' }, 'auto-ack'],
    ] as const) {
      await within(t, cut === undefined ? {} : { cut }, async (w) => {
        const sender = createSender(w.deps)
        valueOf(sender.approve('app-1', 'initial'))
        write(w.db, (q) => repo.appendEvent(q, { kind: 'reply', applicationId: 'app-1', companyId: 'company-1', data: { deferred: true, class: kind } }, w.clock.now()))
        await sender.settled()
        const app = appOf(w.db)
        assert.equal(app.sends[0]?.state, 'sent')
        assert.equal(app.state, kind === 'rejection' ? 'closed' : 'sent')
        assert.equal(eventsOf(w.db).filter((e) => e.kind === 'reply-applied').length, 1)
      })
    }
  })

  test('the opening tx: after recoverOnStart (T-S4), a pending deferred reply is applied (T-S7 + T-A17); an unknown class is cited and skipped', async (t) => {
    await within(t, {}, async (w) => {
      write(w.db, (q) => {
        q.run("UPDATE applications SET state = 'sending' WHERE id = 'app-1'")
        q.run("INSERT INTO sends (application_id, kind, channel, message_id, state, at, profile_version) VALUES ('app-1', 'initial', 'smtp', '<m@jobs.factotum.local>', 'sending', ?, 1)", w.clock.now().toISOString())
        repo.appendEvent(q, { kind: 'reply', applicationId: 'app-1', companyId: 'company-1', data: { deferred: true, class: 'nonsense' } }, w.clock.now())
        repo.appendEvent(q, { kind: 'reply', applicationId: 'app-1', companyId: 'company-1', data: { deferred: true, class: 'offer', messageId: '<m@jobs.factotum.local>' } }, w.clock.now())
      })
      const applied = write(w.db, (q) => {
        repo.recoverOnStart(q, w.clock.now())
        return valueOf(applyDeferredRepliesOnStart(q, w.clock.now()))
      })
      assert.equal(applied, 2)
      const app = appOf(w.db)
      assert.equal(app.state, 'replied')
      assert.equal(app.outcome, 'offer')
      assert.equal(app.sends[0]?.state, 'sent')
      const cited = eventsOf(w.db).filter((e) => e.kind === 'reply-applied').map((e) => e.data)
      assert.equal(cited[0]?.skipped, 'unknown-class')
      assert.equal(cited[1]?.class, 'offer')
      // Nothing left to apply.
      assert.equal(write(w.db, (q) => valueOf(applyDeferredRepliesOnStart(q, w.clock.now()))), 0)
    })
  })

  test('a deferred reply waits while the initial is still sending', async (t) => {
    await within(t, {}, async (w) => {
      write(w.db, (q) => {
        q.run("UPDATE applications SET state = 'sending' WHERE id = 'app-1'")
        q.run("INSERT INTO sends (application_id, kind, channel, message_id, state, at, profile_version) VALUES ('app-1', 'initial', 'smtp', '<m@jobs.factotum.local>', 'sending', ?, 1)", w.clock.now().toISOString())
        repo.appendEvent(q, { kind: 'reply', applicationId: 'app-1', companyId: 'company-1', data: { deferred: true, class: 'offer' } }, w.clock.now())
      })
      assert.equal(write(w.db, (q) => valueOf(applyDeferredRepliesOnStart(q, w.clock.now()))), 0)
      assert.equal(appOf(w.db).state, 'sending')
    })
  })

  test('send(id, kind) is the poll: the row, or not-found', async (t) => {
    await within(t, {}, async (w) => {
      const sender = createSender(w.deps)
      errorOf(sender.send('app-1', 'initial'), 'not-found')
      valueOf(sender.approve('app-1', 'initial'))
      assert.equal(valueOf(sender.send('app-1', 'initial')).state, 'sending')
      await sender.settled()
      assert.equal(valueOf(sender.send('app-1', 'initial')).state, 'sent')
      errorOf(sender.send('nope', 'initial'), 'not-found')
    })
  })
})
