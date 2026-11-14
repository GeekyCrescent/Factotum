/**
 * E3 — «It went», «Send again», «It didn't go», «Retry» and «Mark as sent», on THAT row of `sends`
 * (design D9, D3 T-S5…T-S10, T-A13, T-A17, T-A18, T-A31). The follow-up cases of these live in F2b.
 * (R41, R49)
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { applicationReturned } from '../ai/returns.ts'
import { ADDRESSES, errorOf, followup, followupVersion, valueOf } from '../test-state.ts'
import { appOf, artifacts, decoded, eventsOf, sentWithFollowup, world, write, type World, type WorldOptions } from '../test-send.ts'
import { ok, type AppState, type Followup, type SendState } from '../types.ts'
import { createAssist, type AssistDeps } from './assist.ts'
import { createSender, type Sender } from './send.ts'

const M1 = '<m1@jobs.factotum.local>'

async function within(t: { skip: (m: string) => void }, options: WorldOptions, body: (w: World, sender: Sender, deps: AssistDeps) => Promise<void>): Promise<void> {
  const w = await world(options)
  if (w === null) return t.skip('openssl is not installed: the send tests need it for a throwaway CA')
  const sender = createSender(w.deps)
  const deps: AssistDeps = { db: w.db, now: w.clock.now, timeZone: w.deps.timeZone, maxSendsPerDay: 40, sender, enqueueCheck: w.deps.enqueueCheck }
  try {
    await body(w, sender, deps)
  } finally {
    await sender.stop()
    await w.close()
  }
}

/** The application in `appState` with its initial row in `state`, id M1. */
function initialIn(q: Queries, appState: AppState, state: SendState, reason: string | null = null): void {
  q.run('UPDATE applications SET state = ? WHERE id = ?', appState, 'app-1')
  q.run(
    "INSERT INTO sends (application_id, kind, channel, message_id, state, at, reason, profile_version, artifacts_version) VALUES ('app-1', 'initial', 'smtp', ?, ?, '2026-11-13T22:00:00.000Z', ?, 1, 1)",
    M1,
    state,
    reason,
  )
}

const rows = (w: World) => w.db.read((q) => q.all<{ rowid: number; kind: string }>('SELECT rowid, kind FROM sends ORDER BY rowid'))
const kindsOf = (w: World): readonly string[] => eventsOf(w.db).map((e) => e.kind)

describe('the assistance actions on the initial (E3)', () => {
  test('«It went» → sent (T-A17 + T-S5), event `sent`', async (t) => {
    await within(t, {}, async (w, _sender, deps) => {
      write(w.db, (q) => initialIn(q, 'send-unknown', 'send-unknown'))
      const row = valueOf(createAssist(deps).resolveUnknown('app-1', 'initial', 'went'))
      assert.equal(row.state, 'sent')
      assert.equal(appOf(w.db).state, 'sent')
      assert.deepEqual(eventsOf(w.db).filter((e) => e.kind === 'sent').map((e) => e.data), [{ kind: 'initial', messageId: M1, answer: 'went' }])
    })
  })

  test('«Send again» reuses the messageId (T-A18 + T-S6) and goes through steps 2–3', async (t) => {
    await within(t, {}, async (w, sender, deps) => {
      write(w.db, (q) => initialIn(q, 'send-unknown', 'send-unknown'))
      const row = valueOf(createAssist(deps).resolveUnknown('app-1', 'initial', 'again'))
      assert.equal(row.state, 'sending')
      assert.equal(row.messageId, M1)
      await sender.settled()
      assert.equal(appOf(w.db).state, 'sent')
      assert.equal(appOf(w.db).sends[0]?.messageId, M1)
      assert.ok((w.server.messages[0] ?? '').includes(`Message-ID: ${M1}`))
      assert.deepEqual(eventsOf(w.db).find((e) => e.kind === 'approved')?.data, { kind: 'initial', again: true })
    })
  })

  test('«Send again» respects the daily cap', async (t) => {
    await within(t, {}, async (w, _sender, deps) => {
      write(w.db, (q) => initialIn(q, 'send-unknown', 'send-unknown'))
      errorOf(createAssist({ ...deps, maxSendsPerDay: 1 }).resolveUnknown('app-1', 'initial', 'again'), 'limit', 'daily-cap')
      assert.equal(appOf(w.db).state, 'send-unknown')
    })
  })

  test('«Retry» of a failed initial goes back to sending IN THE SAME ROW (T-S8: UPDATE, no INSERT), new messageId, the old one in attempts', async (t) => {
    await within(t, {}, async (w, sender, deps) => {
      write(w.db, (q) => initialIn(q, 'ready', 'failed', 'the server rejected the recipient'))
      const before = rows(w)
      const row = valueOf(createAssist(deps).retrySend('app-1', 'initial'))
      assert.equal(row.state, 'sending')
      assert.notEqual(row.messageId, M1)
      assert.deepEqual(row.attempts, [{ messageId: M1, at: '2026-11-13T22:00:00.000Z', reason: 'the server rejected the recipient' }])
      assert.deepEqual(rows(w), before, 'the same row: no INSERT, no clash on (application_id, kind)')
      await sender.settled()
      assert.equal(appOf(w.db).state, 'sent')
      assert.deepEqual(rows(w), before)
    })
  })

  test('«Approve» of the batch on that same ready is T-S8 too (v6 M1): same row, no INSERT', async (t) => {
    await within(t, {}, async (w, sender) => {
      write(w.db, (q) => initialIn(q, 'ready', 'failed'))
      const before = rows(w)
      valueOf(sender.approve('app-1', 'initial'))
      const row = appOf(w.db).sends[0]
      assert.equal(row?.state, 'sending')
      assert.deepEqual(row?.attempts.map((a) => a.messageId), [M1])
      assert.deepEqual(rows(w), before)
      await sender.settled()
    })
  })

  test("«It didn't go» of a send-unknown initial (v6 M2) → failed owner-not-sent, ready, `send-failed`, no `sent`; its Retry is T-S8 with the old id in attempts", async (t) => {
    await within(t, {}, async (w, sender, deps) => {
      write(w.db, (q) => initialIn(q, 'send-unknown', 'send-unknown'))
      const assist = createAssist(deps)
      const row = valueOf(assist.resolveUnknown('app-1', 'initial', 'not-went'))
      assert.equal(row.state, 'failed')
      assert.equal(row.reason, 'owner-not-sent')
      assert.equal(appOf(w.db).state, 'ready')
      assert.deepEqual(eventsOf(w.db).filter((e) => e.kind === 'send-failed').map((e) => e.data), [{ kind: 'initial', reason: 'owner-not-sent' }])
      assert.ok(!kindsOf(w).includes('sent'))

      const retried = valueOf(assist.retrySend('app-1', 'initial'))
      assert.equal(retried.state, 'sending')
      assert.deepEqual(retried.attempts.map((a) => [a.messageId, a.reason]), [[M1, 'owner-not-sent']])
      assert.equal(rows(w).length, 1)
      await sender.settled()
    })
  })

  test('each action refuses a row in the wrong state, and an unknown application', async (t) => {
    await within(t, {}, async (w, _sender, deps) => {
      const assist = createAssist(deps)
      errorOf(assist.resolveUnknown('nope', 'initial', 'went'), 'not-found')
      errorOf(assist.retrySend('nope', 'initial'), 'not-found')
      errorOf(assist.markSent('nope', 'initial'), 'not-found')
      write(w.db, (q) => initialIn(q, 'sent', 'sent'))
      errorOf(assist.resolveUnknown('app-1', 'initial', 'went'), 'conflict')
      errorOf(assist.retrySend('app-1', 'initial'), 'conflict')
      errorOf(assist.markSent('app-1', 'initial'), 'conflict')
      assert.equal(appOf(w.db).sends[0]?.state, 'sent')
    })
  })

  test('markSent of a form → a `manual` row, event `sent { kind, manual: true }`; without it, «approved, not sent»; never counted by the cap', async (t) => {
    await within(t, { app: { channel: 'form', target: { contactId: null, to: null, url: 'https://acme.example/jobs/1', contactName: null, instruction: null } } }, async (w, sender, deps) => {
      assert.deepEqual(valueOf(sender.approve('app-1', 'initial')), { state: 'approved', kind: 'initial' })
      assert.equal(appOf(w.db).state, 'approved')
      assert.deepEqual(appOf(w.db).sends, [])
      const app = valueOf(createAssist(deps).markSent('app-1', 'initial'))
      assert.equal(app.state, 'sent')
      assert.equal(app.sends[0]?.channel, 'manual')
      assert.equal(app.sends[0]?.messageId, null)
      assert.equal(app.sends[0]?.state, 'sent')
      assert.deepEqual(eventsOf(w.db).filter((e) => e.kind === 'sent').map((e) => e.data), [{ kind: 'initial', manual: true }])
      assert.equal(w.server.commands.length, 0)
    })
  })
})

describe('the follow-up row moves through the injected step (F2b connects it)', () => {
  test('markSent of a LinkedIn follow-up calls the step and writes its manual row (T-F7)', async (t) => {
    await within(t, {}, async (w, _sender, deps) => {
      write(w.db, (q) => sentWithFollowup(q, followup({ channel: 'linkedin', contactId: null, to: null })))
      const seen: string[] = []
      const assist = createAssist({
        ...deps,
        moveFollowup: (_q, f: Followup, event) => {
          seen.push(event.type)
          return ok({ ...f, state: 'sent' as const })
        },
      })
      valueOf(assist.markSent('app-1', 'followup-1'))
      assert.deepEqual(seen, ['mark-sent'])
      assert.equal(w.db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, 'sent')
      const row = appOf(w.db).sends.find((s) => s.kind === 'followup-1')
      assert.equal(row?.channel, 'manual')
      assert.equal(row?.followupId, 'fu-1')
    })
  })

  test('a follow-up send-unknown: «It went», «Send again» and «Retry» of a failed one move the follow-up with its row', async (t) => {
    await within(t, {}, async (w, sender, deps) => {
      write(w.db, (q) => {
        sentWithFollowup(q, followup({ state: 'send-unknown' }))
        q.run("INSERT INTO sends (application_id, kind, followup_id, channel, message_id, state, at, profile_version, artifacts_version) VALUES ('app-1', 'followup-1', 'fu-1', 'smtp', '<f1@jobs.factotum.local>', 'send-unknown', '2026-11-13T22:00:00.000Z', 1, 1)")
      })
      const assist = createAssist(deps)
      assert.equal(valueOf(assist.resolveUnknown('app-1', 'followup-1', 'again')).messageId, '<f1@jobs.factotum.local>')
      await sender.settled()
      assert.equal(w.db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, 'sent')
      assert.equal(appOf(w.db).state, 'sent')
    })
  })

  test("follow-up «It went», «It didn't go» (with the application replied) and «Retry»", async (t) => {
    await within(t, {}, async (w, sender, deps) => {
      write(w.db, (q) => {
        sentWithFollowup(q, followup({ state: 'send-unknown' }))
        q.run("INSERT INTO sends (application_id, kind, followup_id, channel, message_id, state, at, profile_version, artifacts_version) VALUES ('app-1', 'followup-1', 'fu-1', 'smtp', '<f1@jobs.factotum.local>', 'send-unknown', '2026-11-13T22:00:00.000Z', 1, 1)")
      })
      const assist = createAssist(deps)
      errorOf(assist.resolveUnknown('app-1', 'followup-1', 'not-went'), 'conflict')
      write(w.db, (q) => q.run("UPDATE applications SET state = 'replied' WHERE id = 'app-1'"))
      const failed = valueOf(assist.resolveUnknown('app-1', 'followup-1', 'not-went'))
      assert.equal(failed.state, 'failed')
      assert.equal(w.db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, 'cancelled')

      write(w.db, (q) => {
        q.run("UPDATE applications SET state = 'sent' WHERE id = 'app-1'")
        q.run("UPDATE followups SET state = 'send-unknown' WHERE id = 'fu-1'")
        q.run("UPDATE sends SET state = 'send-unknown' WHERE kind = 'followup-1'")
      })
      assert.equal(valueOf(assist.resolveUnknown('app-1', 'followup-1', 'went')).state, 'sent')
      assert.equal(w.db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, 'sent')

      write(w.db, (q) => {
        q.run("UPDATE followups SET state = 'failed' WHERE id = 'fu-1'")
        q.run("UPDATE sends SET state = 'failed' WHERE kind = 'followup-1'")
      })
      const retried = valueOf(assist.retrySend('app-1', 'followup-1'))
      assert.equal(retried.state, 'sending')
      assert.deepEqual(retried.attempts.map((a) => a.messageId), ['<f1@jobs.factotum.local>'])
      assert.equal(w.db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, 'sending')
      await sender.settled()
      assert.equal(w.db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, 'sent')
    })
  })
})

/** A follow-up of app-1 whose row is in `state`, id F1. */
function followupRowIn(q: Queries, state: 'send-unknown' | 'failed'): void {
  sentWithFollowup(q, followup({ state }))
  q.run("INSERT INTO sends (application_id, kind, followup_id, channel, message_id, state, at, profile_version, artifacts_version) VALUES ('app-1', 'followup-1', 'fu-1', 'smtp', '<f1@jobs.factotum.local>', ?, '2026-11-13T22:00:00.000Z', 1, 1)", state)
}

const followupRow = (w: World) => appOf(w.db).sends.find((s) => s.kind === 'followup-1')

describe('«Send again» and a follow-up «Retry» pass the address guard of «Approve» (D9 step 2, revisión de E)', () => {
  test('«Send again» of the initial: unverified checked → blocked; checking → conflict + the check in front; nothing moves', async (t) => {
    for (const [address, code, reason] of [
      [ADDRESSES.unverifiedToday, 'blocked', 'address-unverified'],
      [ADDRESSES.checking, 'conflict', 'check-pending'],
    ] as const) {
      await within(t, { address }, async (w, _sender, deps) => {
        write(w.db, (q) => initialIn(q, 'send-unknown', 'send-unknown'))
        errorOf(createAssist(deps).resolveUnknown('app-1', 'initial', 'again'), code, reason)
        assert.equal(appOf(w.db).state, 'send-unknown')
        assert.equal(appOf(w.db).sends[0]?.state, 'send-unknown')
        assert.deepEqual(w.enqueued, code === 'conflict' ? [{ contactId: 'contact-1', front: true }] : [])
        assert.equal(w.server.commands.length, 0)
      })
    }
  })

  test('«Send again» with «Send anyway» on a finished unverified check writes the contact override (T-D5) and goes', async (t) => {
    await within(t, { address: ADDRESSES.unverifiedToday }, async (w, sender, deps) => {
      write(w.db, (q) => initialIn(q, 'send-unknown', 'send-unknown'))
      valueOf(createAssist(deps).resolveUnknown('app-1', 'initial', 'again', { addressOverride: true }))
      assert.notEqual(w.db.read((q) => repo.getContact(q, 'contact-1'))?.address?.override ?? null, null)
      await sender.settled()
      assert.equal(appOf(w.db).state, 'sent')
    })
  })

  test('«Send again» to a contact whose email was edited → blocked address-changed', async (t) => {
    await within(t, {}, async (w, _sender, deps) => {
      write(w.db, (q) => {
        initialIn(q, 'send-unknown', 'send-unknown')
        q.run("UPDATE contacts SET email = 'other@acme.example' WHERE id = 'contact-1'")
      })
      errorOf(createAssist(deps).resolveUnknown('app-1', 'initial', 'again'), 'blocked', 'address-changed')
      assert.equal(appOf(w.db).state, 'send-unknown')
    })
  })

  test('a follow-up «Send again» and «Retry»: unverified checked → blocked; checking → conflict + the check in front', async (t) => {
    for (const [state, act] of [
      ['send-unknown', (a: ReturnType<typeof createAssist>) => a.resolveUnknown('app-1', 'followup-1', 'again')],
      ['failed', (a: ReturnType<typeof createAssist>) => a.retrySend('app-1', 'followup-1')],
    ] as const) {
      for (const [address, code, reason] of [
        [ADDRESSES.unverifiedToday, 'blocked', 'address-unverified'],
        [ADDRESSES.checking, 'conflict', 'check-pending'],
      ] as const) {
        await within(t, { address }, async (w, _sender, deps) => {
          write(w.db, (q) => followupRowIn(q, state))
          errorOf(act(createAssist(deps)), code, reason)
          assert.equal(followupRow(w)?.state, state)
          assert.equal(w.db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, state)
          assert.deepEqual(w.enqueued, code === 'conflict' ? [{ contactId: 'contact-1', front: true }] : [])
        })
      }
    }
  })

  test('a follow-up «Retry» with an existing override goes and its row carries it', async (t) => {
    await within(t, { address: ADDRESSES.unverifiedTodayOverride }, async (w, sender, deps) => {
      write(w.db, (q) => followupRowIn(q, 'failed'))
      assert.equal(valueOf(createAssist(deps).retrySend('app-1', 'followup-1')).addressOverride, true)
      await sender.settled()
      assert.equal(followupRow(w)?.state, 'sent')
    })
  })
})

describe('an answer carries the state the screen saw: another device moved the row → conflict stale (D15)', () => {
  const AT = '2026-11-13T22:00:00.000Z'
  const EARLIER = '2026-11-13T21:00:00.000Z'

  test('«Send again», «It went» and «It didn’t go» of the initial: a different state or `at` → stale, nothing moves, nothing sent', async (t) => {
    for (const answer of ['again', 'went', 'not-went'] as const) {
      for (const expect of [
        { state: 'send-unknown', at: EARLIER },
        { state: 'failed', at: AT },
      ] as const) {
        await within(t, {}, async (w, sender, deps) => {
          write(w.db, (q) => initialIn(q, 'send-unknown', 'send-unknown'))
          errorOf(createAssist(deps).resolveUnknown('app-1', 'initial', answer, { expect }), 'conflict', 'stale')
          assert.equal(appOf(w.db).state, 'send-unknown')
          assert.equal(appOf(w.db).sends[0]?.state, 'send-unknown')
          await sender.settled()
          assert.equal(w.server.messages.length, 0)
        })
      }
    }
  })

  test('the row as the screen saw it: the answer goes through', async (t) => {
    await within(t, {}, async (w, sender, deps) => {
      write(w.db, (q) => initialIn(q, 'send-unknown', 'send-unknown'))
      assert.equal(valueOf(createAssist(deps).resolveUnknown('app-1', 'initial', 'again', { expect: { state: 'send-unknown', at: AT } })).state, 'sending')
      await sender.settled()
      assert.equal(appOf(w.db).state, 'sent')
    })
  })

  test('«Retry» of the initial: stale when the row moved, goes when it did not', async (t) => {
    await within(t, {}, async (w, sender, deps) => {
      write(w.db, (q) => initialIn(q, 'ready', 'failed'))
      const assist = createAssist(deps)
      errorOf(assist.retrySend('app-1', 'initial', { expect: { state: 'failed', at: EARLIER } }), 'conflict', 'stale')
      assert.equal(appOf(w.db).sends[0]?.state, 'failed')
      assert.equal(valueOf(assist.retrySend('app-1', 'initial', { expect: { state: 'failed', at: AT } })).state, 'sending')
      await sender.settled()
    })
  })

  test('a follow-up: «Retry» and «It went» stale when the row moved; «Retry» goes when it did not', async (t) => {
    await within(t, {}, async (w, sender, deps) => {
      write(w.db, (q) => followupRowIn(q, 'failed'))
      const assist = createAssist(deps)
      errorOf(assist.retrySend('app-1', 'followup-1', { expect: { state: 'send-unknown', at: AT } }), 'conflict', 'stale')
      errorOf(assist.resolveUnknown('app-1', 'followup-1', 'went', { expect: { state: 'send-unknown', at: AT } }), 'conflict', 'stale')
      assert.equal(followupRow(w)?.state, 'failed')
      assert.equal(valueOf(assist.retrySend('app-1', 'followup-1', { expect: { state: 'failed', at: AT } })).state, 'sending')
      await sender.settled()
    })
  })
})

describe('what goes out is the version approved at step 1 (D9, revisión del corte 1a)', () => {
  const NEW_SUBJECT = 'A later letter nobody approved'
  const returnsDeps = { lint: () => [], relintOne: () => ok(undefined), pdfExists: () => true }
  const AT = '2026-11-13T22:00:00.000Z'
  const work: repo.Work = { id: 'w-letter', kind: 'letter', ref: 'app-1', lane: 'bulk', state: 'done', attempts: 0, notBefore: null, reason: null, createdAt: AT, updatedAt: AT }
  const laterLetter = { letter: { subject: NEW_SUBJECT, body: 'Unapproved {signature}' }, profileVersion: 1, rules: [], usage: null, origin: 'generated' as const }
  /** A version 2 the owner never approved, written straight into the store. */
  const laterVersion = (q: Queries): void => {
    repo.insertArtifacts(q, 'app-1', { ...artifacts(2, null), letter: laterLetter.letter }, new Date(AT))
    q.run("UPDATE applications SET version = 2 WHERE id = 'app-1'")
  }

  test('step 1 pins the approved version on the row (artifacts_version)', async (t) => {
    await within(t, {}, async (w, sender) => {
      valueOf(sender.approve('app-1', 'initial'))
      assert.equal(appOf(w.db).sends[0]?.artifactsVersion, 1)
      await sender.settled()
    })
  })

  test('a letter that comes back while the initial is sending is discarded: no version 2, and the mail carries version 1', async (t) => {
    await within(t, {}, async (w, sender) => {
      valueOf(sender.approve('app-1', 'initial'))
      write(w.db, (q) => valueOf(applicationReturned(q, work, laterLetter, returnsDeps, w.clock.now())))
      await sender.settled()
      assert.equal(appOf(w.db).version, 1)
      assert.equal(eventsOf(w.db).find((e) => e.kind === 'prepared')?.data.discarded, true)
      assert.equal(w.server.messages.length, 1)
      assert.ok(!decoded(w.server.messages[0] ?? '').includes(NEW_SUBJECT))
    })
  })

  test('a letter that comes back while the initial is send-unknown is discarded; «Send again» mails version 1', async (t) => {
    await within(t, {}, async (w, sender, deps) => {
      write(w.db, (q) => initialIn(q, 'send-unknown', 'send-unknown'))
      write(w.db, (q) => valueOf(applicationReturned(q, work, laterLetter, returnsDeps, w.clock.now())))
      assert.equal(appOf(w.db).version, 1)
      valueOf(createAssist(deps).resolveUnknown('app-1', 'initial', 'again'))
      await sender.settled()
      assert.equal(appOf(w.db).state, 'sent')
      const mail = decoded(w.server.messages[0] ?? '')
      assert.ok(mail.includes('I would like to apply'), 'the approved letter went')
      assert.ok(!mail.includes('Unapproved') && !mail.includes(NEW_SUBJECT))
    })
  })

  test('«Send again» after a later version → blocked stale-version: nothing moves, nothing sent', async (t) => {
    await within(t, {}, async (w, sender, deps) => {
      write(w.db, (q) => {
        initialIn(q, 'send-unknown', 'send-unknown')
        laterVersion(q)
      })
      errorOf(createAssist(deps).resolveUnknown('app-1', 'initial', 'again'), 'blocked', 'stale-version')
      assert.equal(appOf(w.db).sends[0]?.state, 'send-unknown')
      await sender.settled()
      assert.equal(w.server.messages.length, 0)
    })
  })

  test('«Retry» of a failed initial after a later version → blocked stale-version (only «Approve» of what was seen sends it)', async (t) => {
    await within(t, {}, async (w, sender, deps) => {
      write(w.db, (q) => {
        initialIn(q, 'ready', 'failed')
        laterVersion(q)
      })
      errorOf(createAssist(deps).retrySend('app-1', 'initial'), 'blocked', 'stale-version')
      assert.equal(appOf(w.db).sends[0]?.state, 'failed')
      await sender.settled()
      assert.equal(w.server.messages.length, 0)
    })
  })

  test('a follow-up «Send again» and «Retry» after a later version of its text → blocked stale-version', async (t) => {
    for (const [state, act] of [
      ['send-unknown', (a: ReturnType<typeof createAssist>) => a.resolveUnknown('app-1', 'followup-1', 'again')],
      ['failed', (a: ReturnType<typeof createAssist>) => a.retrySend('app-1', 'followup-1')],
    ] as const) {
      await within(t, {}, async (w, sender, deps) => {
        write(w.db, (q) => {
          sentWithFollowup(q, followup({ state, version: 2, versions: [followupVersion(1), followupVersion(2)] }))
          q.run("INSERT INTO sends (application_id, kind, followup_id, channel, message_id, state, at, profile_version, artifacts_version) VALUES ('app-1', 'followup-1', 'fu-1', 'smtp', '<f1@jobs.factotum.local>', ?, ?, 1, 1)", state, AT)
        })
        errorOf(act(createAssist(deps)), 'blocked', 'stale-version')
        assert.equal(followupRow(w)?.state, state)
        await sender.settled()
        assert.equal(w.server.messages.length, 0)
      })
    }
  })
})
