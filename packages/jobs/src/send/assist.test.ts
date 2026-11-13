/**
 * E3 — «It went», «Send again», «It didn't go», «Retry» and «Mark as sent», on THAT row of `sends`
 * (design D9, D3 T-S5…T-S10, T-A13, T-A17, T-A18, T-A31). The follow-up cases of these live in F2b.
 * (R41, R49)
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { errorOf, followup, valueOf } from '../test-state.ts'
import { appOf, eventsOf, sentWithFollowup, world, write, type World, type WorldOptions } from '../test-send.ts'
import { ok, type AppState, type Followup, type SendState } from '../types.ts'
import { createAssist, type AssistDeps } from './assist.ts'
import { createSender, type Sender } from './send.ts'

const M1 = '<m1@jobs.factotum.local>'

async function within(t: { skip: (m: string) => void }, options: WorldOptions, body: (w: World, sender: Sender, deps: AssistDeps) => Promise<void>): Promise<void> {
  const w = await world(options)
  if (w === null) return t.skip('openssl is not installed: the send tests need it for a throwaway CA')
  const sender = createSender(w.deps)
  const deps: AssistDeps = { db: w.db, now: w.clock.now, timeZone: w.deps.timeZone, maxSendsPerDay: 40, sender }
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
    "INSERT INTO sends (application_id, kind, channel, message_id, state, at, reason, profile_version) VALUES ('app-1', 'initial', 'smtp', ?, ?, '2026-11-13T22:00:00.000Z', ?, 1)",
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
        q.run("INSERT INTO sends (application_id, kind, followup_id, channel, message_id, state, at, profile_version) VALUES ('app-1', 'followup-1', 'fu-1', 'smtp', '<f1@jobs.factotum.local>', 'send-unknown', '2026-11-13T22:00:00.000Z', 1)")
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
        q.run("INSERT INTO sends (application_id, kind, followup_id, channel, message_id, state, at, profile_version) VALUES ('app-1', 'followup-1', 'fu-1', 'smtp', '<f1@jobs.factotum.local>', 'send-unknown', '2026-11-13T22:00:00.000Z', 1)")
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
