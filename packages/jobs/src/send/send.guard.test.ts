/**
 * E2 — the daily cap and the address guard, with the fixtures of «Qué responde el motor» (design D3,
 * v5 X4). (R43, R45, R47)
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { AddressOutcome, AddressSearch } from '../build/address.ts'
import { createCheckQueue } from '../build/checks.ts'
import type { Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { ADDRESSES, errorOf, followup, valueOf } from '../test-state.ts'
import { eventually } from '../test-support.ts'
import { addApplication, appOf, eventsOf, sentWithFollowup, world, write, type World, type WorldOptions } from '../test-send.ts'
import type { Address } from '../types.ts'
import { createSender, dailyCap, dayIn } from './send.ts'

async function within(t: { skip: (m: string) => void }, options: WorldOptions, body: (w: World) => Promise<void>): Promise<void> {
  const w = await world(options)
  if (w === null) return t.skip('openssl is not installed: the send tests need it for a throwaway CA')
  try {
    await body(w)
  } finally {
    await w.close()
  }
}

/** `count` other applications, each with an `initial` row of this channel and state at `at`. */
function otherSends(q: Queries, count: number, row: { channel: 'smtp' | 'manual'; state: string; at: string }, prefix = 'other'): void {
  for (let i = 0; i < count; i += 1) {
    const id = `${prefix}-${i}`
    addApplication(q, id, { state: 'sent' })
    q.run(
      'INSERT INTO sends (application_id, kind, channel, message_id, state, at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      'initial',
      row.channel,
      row.channel === 'smtp' ? `<${id}@jobs.factotum.local>` : null,
      row.state,
      row.at,
    )
  }
}

const setAddress = (w: World, address: Address): void =>
  void write(w.db, (q) => q.run('UPDATE contacts SET address_status = ?, checked_at = ?, override_at = ?, verified_url = ? WHERE id = ?', address.status, address.checkedAt, address.override?.at ?? null, address.verifiedUrl, 'contact-1'))

const contactAddress = (w: World): Address | null | undefined => w.db.read((q) => repo.getContact(q, 'contact-1')?.address)

describe('the daily cap (E2)', () => {
  test('the zone decides «today»: 23:59 in Sydney yesterday is not today, 00:00 is', () => {
    const now = new Date('2026-11-14T00:00:00.000Z') // 11:00 in Sydney
    assert.equal(dayIn(now, 'Australia/Sydney'), '2026-11-14')
    assert.equal(dayIn(new Date('2026-11-13T12:59:59.000Z'), 'Australia/Sydney'), '2026-11-13')
    assert.equal(dayIn(new Date('2026-11-13T13:00:00.000Z'), 'Australia/Sydney'), '2026-11-14')
  })

  test('counts smtp rows not failed of today in the zone, of any kind; failed, manual and yesterday are not counted', async (t) => {
    await within(t, {}, async (w) => {
      write(w.db, (q) => {
        otherSends(q, 2, { channel: 'smtp', state: 'sent', at: '2026-11-13T13:00:00.000Z' }, 'today')
        otherSends(q, 1, { channel: 'smtp', state: 'send-unknown', at: '2026-11-13T20:00:00.000Z' }, 'unknown')
        otherSends(q, 1, { channel: 'smtp', state: 'sending', at: '2026-11-13T23:00:00.000Z' }, 'sending')
        otherSends(q, 3, { channel: 'smtp', state: 'failed', at: '2026-11-13T20:00:00.000Z' }, 'failed')
        otherSends(q, 3, { channel: 'manual', state: 'sent', at: '2026-11-13T20:00:00.000Z' }, 'manual')
        otherSends(q, 4, { channel: 'smtp', state: 'sent', at: '2026-11-13T12:59:00.000Z' }, 'yesterday')
      })
      const cap = w.db.read((q) => dailyCap(q, w.clock.now(), 'Australia/Sydney', 40))
      assert.deepEqual(cap, { sentToday: 4, maxPerDay: 40 })
    })
  })

  test('the 41st is a follow-up and gets limit (429) with its reason; nothing written', async (t) => {
    await within(t, {}, async (w) => {
      write(w.db, (q) => {
        sentWithFollowup(q, followup())
        otherSends(q, 40, { channel: 'smtp', state: 'sent', at: '2026-11-13T22:00:00.000Z' })
      })
      const sender = createSender(w.deps)
      errorOf(sender.approve('app-1', 'followup-1'), 'limit', 'daily-cap')
      assert.equal(w.db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, 'ready')
      assert.equal(appOf(w.db).sends.length, 1)
    })
  })

  test('a «Mark as sent» does not count: 40 manual rows today and the initial still goes', async (t) => {
    await within(t, {}, async (w) => {
      write(w.db, (q) => otherSends(q, 40, { channel: 'manual', state: 'sent', at: '2026-11-13T22:00:00.000Z' }))
      const sender = createSender(w.deps)
      valueOf(sender.approve('app-1', 'initial'))
      await sender.settled()
      assert.equal(appOf(w.db).state, 'sent')
    })
  })

  test('the 41st initial gets limit too, and the application stays ready', async (t) => {
    await within(t, {}, async (w) => {
      write(w.db, (q) => otherSends(q, 40, { channel: 'smtp', state: 'send-unknown', at: '2026-11-13T22:00:00.000Z' }))
      errorOf(createSender(w.deps).approve('app-1', 'initial'), 'limit', 'daily-cap')
      assert.equal(appOf(w.db).state, 'ready')
      assert.deepEqual(appOf(w.db).sends, [])
    })
  })
})

describe('the address guard: «Qué responde el motor» (E2, v5 X4)', () => {
  test('unverified, checked today, no override → blocked address-unverified, no row, the email stays ready', async (t) => {
    await within(t, { address: ADDRESSES.unverifiedToday }, async (w) => {
      errorOf(createSender(w.deps).approve('app-1', 'initial'), 'blocked', 'address-unverified')
      assert.equal(appOf(w.db).state, 'ready')
      assert.deepEqual(appOf(w.db).sends, [])
      assert.deepEqual(w.enqueued, [])
    })
  })

  for (const [name, address] of [
    ['unverified never checked', ADDRESSES.unverifiedNeverChecked],
    ['checking', ADDRESSES.checking],
    ['verified 15 days ago', ADDRESSES.verifiedStale],
    ['unverified 15 days ago with override', ADDRESSES.unverifiedStaleOverride],
  ] as const) {
    test(`${name} → conflict check-pending (also with addressOverride), no row, the check queued in front`, async (t) => {
      await within(t, { address }, async (w) => {
        const sender = createSender(w.deps)
        errorOf(sender.approve('app-1', 'initial'), 'conflict', 'check-pending')
        errorOf(sender.approve('app-1', 'initial', { addressOverride: true }), 'conflict', 'check-pending')
        assert.deepEqual(appOf(w.db).sends, [])
        assert.equal(appOf(w.db).state, 'ready')
        assert.deepEqual(w.enqueued, [
          { contactId: 'contact-1', front: true },
          { contactId: 'contact-1', front: true },
        ])
        assert.equal(contactAddress(w)?.override?.at ?? null, address.override?.at ?? null, 'no override written')
      })
    })
  }

  test('«Send anyway» on unverified checked today writes the override on the contact in the same tx (T-D5) and the send carries it', async (t) => {
    await within(t, { address: ADDRESSES.unverifiedToday }, async (w) => {
      const sender = createSender(w.deps)
      valueOf(sender.approve('app-1', 'initial', { addressOverride: true }))
      assert.equal(contactAddress(w)?.override?.at, w.clock.now().toISOString())
      assert.equal(contactAddress(w)?.status, 'unverified')
      const override = w.db.read((q) => q.all<{ data: string }>("SELECT data FROM events WHERE kind = 'address-override'"))
      assert.deepEqual(override.map((e) => JSON.parse(e.data)), [{ contactId: 'contact-1' }])
      await sender.settled()
      assert.equal(appOf(w.db).sends[0]?.addressOverride, true)
      assert.equal(eventsOf(w.db).find((e) => e.kind === 'sent')?.data.addressOverride, true)
    })
  })

  test('verified today, and unverified with an override, pass without asking', async (t) => {
    for (const [address, carried] of [
      [ADDRESSES.verifiedToday, false],
      [ADDRESSES.unverifiedTodayOverride, true],
    ] as const) {
      await within(t, { address }, async (w) => {
        const sender = createSender(w.deps)
        valueOf(sender.approve('app-1', 'initial'))
        await sender.settled()
        assert.equal(appOf(w.db).state, 'sent')
        assert.equal(eventsOf(w.db).find((e) => e.kind === 'sent')?.data.addressOverride, carried)
        assert.equal(eventsOf(w.db).some((e) => e.kind === 'address-override'), false)
      })
    }
  })

  test("the initial's override serves its followup-1 to the same address without asking again", async (t) => {
    await within(t, { address: ADDRESSES.unverifiedToday }, async (w) => {
      write(w.db, (q) => sentWithFollowup(q, followup()))
      const sender = createSender(w.deps)
      errorOf(sender.approve('app-1', 'followup-1'), 'blocked', 'address-unverified')
      setAddress(w, ADDRESSES.unverifiedTodayOverride)
      valueOf(sender.approve('app-1', 'followup-1'))
      await sender.settled()
      assert.equal(appOf(w.db).sends.find((s) => s.kind === 'followup-1')?.state, 'sent')
      assert.equal(eventsOf(w.db).find((e) => e.kind === 'sent')?.data.addressOverride, true)
    })
  })

  test('«Send anyway» on a follow-up writes the contact override too', async (t) => {
    await within(t, { address: ADDRESSES.unverifiedToday }, async (w) => {
      write(w.db, (q) => sentWithFollowup(q, followup()))
      const sender = createSender(w.deps)
      valueOf(sender.approve('app-1', 'followup-1', { addressOverride: true }))
      assert.notEqual(contactAddress(w)?.override, null)
      await sender.settled()
      assert.equal(eventsOf(w.db).find((e) => e.kind === 'sent')?.data.addressOverride, true)
    })
  })

  test('with the real check queue (N4): checkedAt null → conflict + a pending check in front; unverified → blocked; verified → passes', async (t) => {
    await within(t, { address: ADDRESSES.unverifiedNeverChecked }, async (w) => {
      const answers: ((outcome: AddressOutcome) => void)[] = []
      const search: AddressSearch = () => new Promise((resolve) => answers.push(resolve))
      const queue = createCheckQueue({ db: w.db, timers: w.timers.timers, now: w.clock.now, search, log: { info: () => {}, warn: () => {}, error: () => {} } })
      const sender = createSender({ ...w.deps, enqueueCheck: (id, options) => queue.enqueueCheck(id, options) })

      errorOf(sender.approve('app-1', 'initial'), 'conflict', 'check-pending')
      await eventually(() => answers.length === 1, 'the check runs')
      assert.equal(queue.running(), 'contact-1')
      assert.equal(contactAddress(w)?.status, 'checking')
      errorOf(sender.approve('app-1', 'initial'), 'conflict', 'check-pending')

      answers[0]?.({ kind: 'not-found' })
      await eventually(() => queue.idle(), 'the check finishes')
      errorOf(sender.approve('app-1', 'initial'), 'blocked', 'address-unverified')

      // A re-check that finds it (the address made stale by hand): approving passes.
      setAddress(w, { ...ADDRESSES.unverifiedNeverChecked })
      errorOf(sender.approve('app-1', 'initial'), 'conflict', 'check-pending')
      await eventually(() => answers.length === 2, 'the second check runs')
      answers[1]?.({ kind: 'found', url: 'https://acme.example/contact' })
      await eventually(() => queue.idle() && contactAddress(w)?.status === 'verified', 'verified')
      valueOf(sender.approve('app-1', 'initial'))
      await sender.settled()
      assert.equal(appOf(w.db).state, 'sent')
      await queue.stop()
    })
  })

  test('the recipient is the CONTACT: its edited email (the stored copy stale) → blocked address-changed, no row; initial and follow-up', async (t) => {
    await within(t, {}, async (w) => {
      write(w.db, (q) => q.run("UPDATE contacts SET email = 'other@acme.example' WHERE id = 'contact-1'"))
      const sender = createSender(w.deps)
      errorOf(sender.approve('app-1', 'initial'), 'blocked', 'address-changed')
      assert.equal(appOf(w.db).state, 'ready')
      assert.deepEqual(appOf(w.db).sends, [])
      write(w.db, (q) => sentWithFollowup(q, followup()))
      errorOf(sender.approve('app-1', 'followup-1'), 'blocked', 'address-changed')
      assert.equal(w.db.read((q) => repo.getFollowup(q, 'fu-1'))?.state, 'ready')
      assert.equal(appOf(w.db).sends.length, 1)
      assert.equal(w.server.commands.length, 0)
    })
  })

  test('the contact edited between step 1 and step 2 → nothing sent, the row failed address-changed', async (t) => {
    await within(t, {}, async (w) => {
      write(w.db, (q) => {
        q.run("UPDATE applications SET state = 'sending' WHERE id = 'app-1'")
        q.run("INSERT INTO sends (application_id, kind, channel, message_id, state, at, profile_version, artifacts_version) VALUES ('app-1', 'initial', 'smtp', '<m@jobs.factotum.local>', 'sending', '2026-11-13T22:00:00.000Z', 1, 1)")
        q.run("UPDATE contacts SET email = 'other@acme.example' WHERE id = 'contact-1'")
      })
      const sender = createSender(w.deps)
      sender.launch('app-1', 'initial')
      await sender.settled()
      assert.equal(appOf(w.db).sends[0]?.state, 'failed')
      assert.equal(appOf(w.db).sends[0]?.reason, 'address-changed')
      assert.equal(w.inputs.length, 0)
      assert.equal(w.server.commands.length, 0)
    })
  })

  test('the same address → it goes to the contact’s email, the one the guard judged', async (t) => {
    await within(t, {}, async (w) => {
      write(w.db, (q) => sentWithFollowup(q, followup()))
      const sender = createSender(w.deps)
      valueOf(sender.approve('app-1', 'followup-1'))
      await sender.settled()
      assert.deepEqual(w.inputs.map((i) => i.to), ['ada@acme.example'])
      assert.ok(w.server.commands.some((c) => /^RCPT TO:<?ada@acme\.example>?$/i.test(c)), w.server.commands.join(' '))
    })
  })

  test('an application with no contact is blocked no-address', async (t) => {
    await within(t, {}, async (w) => {
      write(w.db, (q) => q.run("UPDATE applications SET contact_id = NULL WHERE id = 'app-1'"))
      errorOf(createSender(w.deps).approve('app-1', 'initial'), 'blocked', 'no-address')
    })
  })
})
