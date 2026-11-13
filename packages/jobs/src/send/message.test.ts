/**
 * What step 2 puts on the wire (design D9 step 2, D12 rules 1–2), and the edges of step 1 and 3.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { errorOf, followup, followupVersion, valueOf } from '../test-state.ts'
import { fail } from '../types.ts'
import { appOf, artifacts, eventsOf, PHONE, sentWithFollowup, testProfile, world, write, type World, type WorldOptions } from '../test-send.ts'
import { applyDeferredRepliesOnStart } from './deferred.ts'
import { cvFileName, outgoingFor } from './message.ts'
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

/** The initial of app-1 in flight, as step 1 leaves it. */
function inFlight(q: Queries, profileVersion = 1): void {
  q.run("UPDATE applications SET state = 'sending' WHERE id = 'app-1'")
  q.run("INSERT INTO sends (application_id, kind, channel, message_id, state, at, profile_version) VALUES ('app-1', 'initial', 'smtp', '<m@jobs.factotum.local>', 'sending', '2026-11-13T22:00:00.000Z', ?)", profileVersion)
}

/** A follow-up `n` of app-1 in flight. */
function followupInFlight(q: Queries, n: 1 | 2, subject: string | null): void {
  const id = `fu-${n}`
  repo.insertFollowup(q, followup({ id, n, state: 'sending', versions: [followupVersion(1, { subject, body: 'Following up.\n\n{signature}' })] }), { kind: 'followup-proposed' }, new Date())
  q.run(
    "INSERT INTO sends (application_id, kind, followup_id, channel, message_id, state, at, profile_version) VALUES ('app-1', ?, ?, 'smtp', ?, 'sending', '2026-11-13T22:00:00.000Z', 1)",
    `followup-${n}`,
    id,
    `<f${n}@jobs.factotum.local>`,
  )
}

describe('the message of step 2', () => {
  test('cvFileName: the profile name in ASCII, from a closed alphabet', () => {
    const profile = testProfile()
    assert.equal(cvFileName({ ...profile, identity: { ...profile.identity, name: 'Juan Rodrigo Ferro Rayón' } }), 'Juan-Rodrigo-Ferro-Rayon-CV.pdf')
    assert.equal(cvFileName({ ...profile, identity: { ...profile.identity, name: '  ' } }), 'CV.pdf')
  })

  test('the initial: filled, with its CV; refused when not in flight', async (t) => {
    await within(t, {}, async (w) => {
      errorOf(w.db.read((q) => outgoingFor(q, 'app-1', 'initial')), 'conflict')
      write(w.db, (q) => inFlight(q))
      const message = valueOf(w.db.read((q) => outgoingFor(q, 'app-1', 'initial')))
      assert.ok(message.text.includes(PHONE))
      assert.equal(message.attachment?.filename, 'Ada-Applicant-CV.pdf')
      assert.equal(message.inReplyTo, undefined)
    })
  })

  for (const [name, options, setup, reason] of [
    ['no letter', { letter: null }, undefined, 'missing-letter'],
    ['no subject', { letter: { subject: null, body: 'x' } }, undefined, 'missing-subject'],
    ['a stored to that is not the contact\'s email', {}, (q: Queries) => q.run("UPDATE applications SET target = json_set(target, '$.to', '') WHERE id = 'app-1'"), 'address-changed'],
    ['a contact with no email', {}, (q: Queries) => q.run("UPDATE contacts SET email = NULL WHERE id = 'contact-1'"), 'no-address'],
    ['no PDF in the artifact', {}, (q: Queries) => q.run("UPDATE artifacts SET pdf = NULL WHERE application_id = 'app-1'"), 'missing-cv'],
  ] as const) {
    test(`the initial with ${name} → blocked ${reason}`, async (t) => {
      await within(t, options, async (w) => {
        write(w.db, (q) => {
          inFlight(q)
          setup?.(q)
        })
        errorOf(w.db.read((q) => outgoingFor(q, 'app-1', 'initial')), 'blocked', reason)
      })
    })
  }

  test('a profile version the row names but the store lacks → blocked missing-profile', async (t) => {
    await within(t, {}, async (w) => {
      write(w.db, (q) => inFlight(q, 9))
      errorOf(w.db.read((q) => outgoingFor(q, 'app-1', 'initial')), 'blocked', 'missing-profile')
    })
  })

  test('followup-2 in the thread: inReplyTo the last smtp sent, references all in order, Re: not doubled', async (t) => {
    await within(t, { letter: { subject: 'Re: hello', body: 'x {signature}' } }, async (w) => {
      write(w.db, (q) => {
        sentWithFollowup(q, followup({ state: 'sent' }))
        q.run("INSERT INTO sends (application_id, kind, followup_id, channel, message_id, state, at) VALUES ('app-1', 'followup-1', 'fu-1', 'smtp', '<f1@jobs.factotum.local>', 'sent', '2026-11-12T00:00:00.000Z')")
        followupInFlight(q, 2, null)
      })
      const message = valueOf(w.db.read((q) => outgoingFor(q, 'app-1', 'followup-2')))
      assert.equal(message.subject, 'Re: hello')
      assert.equal(message.inReplyTo, '<f1@jobs.factotum.local>')
      assert.deepEqual(message.references, ['<initial@jobs.factotum.local>', '<f1@jobs.factotum.local>'])
      assert.equal(message.attachment, undefined)
    })
  })

  test('a follow-up with no thread (the initial by hand, D12 rule 2): its own subject, no threading; without one, missing-subject', async (t) => {
    await within(t, {}, async (w) => {
      write(w.db, (q) => {
        q.run("UPDATE applications SET state = 'sent' WHERE id = 'app-1'")
        q.run("INSERT INTO sends (application_id, kind, channel, state, at) VALUES ('app-1', 'initial', 'manual', 'sent', '2026-11-05T00:00:00.000Z')")
        followupInFlight(q, 1, 'Following up on my application')
      })
      const message = valueOf(w.db.read((q) => outgoingFor(q, 'app-1', 'followup-1')))
      assert.equal(message.subject, 'Following up on my application')
      assert.equal(message.inReplyTo, undefined)
      assert.equal(message.references, undefined)
      write(w.db, (q) => q.run(`UPDATE followups SET data = json_set(data, '$.versions[0].subject', NULL) WHERE id = 'fu-1'`))
      errorOf(w.db.read((q) => outgoingFor(q, 'app-1', 'followup-1')), 'blocked', 'missing-subject')
      write(w.db, (q) => q.run("UPDATE followups SET version = 7 WHERE id = 'fu-1'"))
      errorOf(w.db.read((q) => outgoingFor(q, 'app-1', 'followup-1')), 'conflict')
    })
  })
})

describe('the edges of steps 1 and 3', () => {
  test('approve: an unknown application or follow-up is not-found; a follow-up with a row already is a conflict', async (t) => {
    await within(t, {}, async (w) => {
      const sender = createSender(w.deps)
      errorOf(sender.approve('nope', 'initial'), 'not-found')
      errorOf(sender.approve('nope', 'followup-1'), 'not-found')
      errorOf(sender.approve('app-1', 'followup-2'), 'not-found')
      write(w.db, (q) => {
        sentWithFollowup(q, followup())
        q.run("INSERT INTO sends (application_id, kind, followup_id, channel, message_id, state, at) VALUES ('app-1', 'followup-1', 'fu-1', 'smtp', '<f1@jobs.factotum.local>', 'failed', '2026-11-12T00:00:00.000Z')")
      })
      errorOf(sender.approve('app-1', 'followup-1'), 'conflict')
    })
  })

  test('a relative artifact path is resolved under stateDir', async (t) => {
    await within(t, {}, async (w) => {
      write(w.db, (q) => q.run("UPDATE artifacts SET pdf = 'cv-v1.pdf' WHERE application_id = 'app-1'"))
      errorOf(createSender(w.deps).approve('app-1', 'initial'), 'blocked', 'missing-cv')
      const sender = createSender({ ...w.deps, stateDir: w.base.dir })
      valueOf(sender.approve('app-1', 'initial'))
      await sender.settled()
      assert.equal(appOf(w.db).state, 'sent')
      assert.ok((w.server.messages[0] ?? '').includes('application/pdf'))
    })
  })

  test('step 3 that cannot be written is logged (no address, no body) and the row stays sending', async (t) => {
    await within(t, {}, async (w) => {
      const sender = createSender({
        ...w.deps,
        sendMail: async (input) => {
          w.db.tx((q) => ({ ok: true, value: q.run("UPDATE applications SET state = 'sent' WHERE id = 'app-1'") }))
          return { ok: true, messageId: input.messageId, response: '250 2.0.0 OK' }
        },
      })
      valueOf(sender.approve('app-1', 'initial'))
      await sender.settled()
      assert.equal(appOf(w.db).sends[0]?.state, 'sending')
      assert.match(w.lines.join('\n'), /step 3 was not written/)
      assert.ok(!w.lines.join('\n').includes('ada@acme.example'))
    })
  })

  test('applying the deferred replies fails after SMTP accepted: the row is still `sent`, the failure logged and an event', async (t) => {
    for (const broken of [() => fail('module-error', 'boom'), () => { throw new Error('boom') }]) {
      await within(t, {}, async (w) => {
        const sender = createSender({ ...w.deps, applyDeferred: broken })
        valueOf(sender.approve('app-1', 'initial'))
        await sender.settled()
        assert.equal(appOf(w.db).sends[0]?.state, 'sent')
        assert.equal(appOf(w.db).state, 'sent')
        assert.ok(eventsOf(w.db).some((e) => e.kind === 'sent'))
        assert.deepEqual(eventsOf(w.db).filter((e) => e.kind === 'deferred-replies-failed').map((e) => e.data.kind), ['initial'])
        assert.match(w.lines.join('\n'), /deferred replies were not applied/)
      })
    }
  })

  test('a deferred reply the table refuses is cited with why, never retried forever', async (t) => {
    await within(t, {}, async (w) => {
      write(w.db, (q) => {
        q.run("UPDATE applications SET state = 'draft' WHERE id = 'app-1'")
        repo.appendEvent(q, { kind: 'reply', applicationId: 'app-1', companyId: 'company-1', data: { deferred: true, class: 'offer' } }, w.clock.now())
      })
      assert.equal(write(w.db, (q) => valueOf(applyDeferredRepliesOnStart(q, w.clock.now()))), 1)
      const cited = eventsOf(w.db).find((e) => e.kind === 'reply-applied')
      assert.equal(typeof cited?.data.skipped, 'string')
      assert.equal(appOf(w.db).state, 'draft')
    })
  })

  test('artifacts of another version are not read: the current version decides', async (t) => {
    await within(t, {}, async (w) => {
      write(w.db, (q) => {
        repo.insertArtifacts(q, 'app-1', artifacts(2, null), w.clock.now())
        q.run("UPDATE applications SET version = 2 WHERE id = 'app-1'")
      })
      errorOf(createSender(w.deps).approve('app-1', 'initial'), 'blocked', 'missing-cv')
    })
  })
})
