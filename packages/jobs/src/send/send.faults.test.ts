/**
 * Steps 2–3 when something throws (D9 steps 2–4, revisión de E): a send never stays `sending` with no
 * event while the daemon runs, and the launched promise never rejects.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Db } from '../store/db.ts'
import { valueOf } from '../test-state.ts'
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

/** The initial of app-1 in flight, as step 1 leaves it. */
const inFlight = (w: World): void =>
  write(w.db, (q) => {
    q.run("UPDATE applications SET state = 'sending' WHERE id = 'app-1'")
    q.run("INSERT INTO sends (application_id, kind, channel, message_id, state, at, profile_version, artifacts_version) VALUES ('app-1', 'initial', 'smtp', '<m@jobs.factotum.local>', 'sending', '2026-11-13T22:00:00.000Z', 1, 1)")
  })

const failedWith = (w: World): { state: string | undefined; reason: string | null | undefined; events: readonly unknown[] } => ({
  state: appOf(w.db).sends[0]?.state,
  reason: appOf(w.db).sends[0]?.reason,
  events: eventsOf(w.db).filter((e) => e.kind === 'send-failed').map((e) => e.data),
})

/** Unhandled rejections seen while `body` runs (and one turn after). */
async function unhandled(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = []
  const listener = (reason: unknown): void => void seen.push(reason)
  process.on('unhandledRejection', listener)
  try {
    await body()
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.off('unhandledRejection', listener)
  }
  return seen
}

describe('a throw in steps 2–3 is routed into step 3 (D9, revisión de E)', () => {
  test('reading the message throws (a damaged row) → failed internal-error with `send-failed`, nothing sent', async (t) => {
    await within(t, {}, async (w) => {
      inFlight(w)
      const db: Db = { ...w.db, read: () => { throw new SyntaxError('Unexpected token') } }
      const sender = createSender({ ...w.deps, db })
      sender.launch('app-1', 'initial')
      await sender.settled()
      assert.deepEqual(failedWith(w), { state: 'failed', reason: 'internal-error', events: [{ kind: 'initial', reason: 'internal-error' }] })
      assert.equal(appOf(w.db).state, 'ready')
      assert.equal(w.inputs.length, 0)
      assert.match(w.lines.join('\n'), /send app-1\/initial: SyntaxError/)
    })
  })

  test('readPassword rejects → failed internal-error with `send-failed`, before any SMTP', async (t) => {
    await within(t, {}, async (w) => {
      const sender = createSender({ ...w.deps, readPassword: () => Promise.reject(new Error('EIO')) })
      valueOf(sender.approve('app-1', 'initial'))
      await sender.settled()
      assert.deepEqual(failedWith(w), { state: 'failed', reason: 'internal-error', events: [{ kind: 'initial', reason: 'internal-error' }] })
      assert.equal(w.server.commands.length, 0)
    })
  })

  test('sendMail rejects (it may have reached DATA) → send-unknown with its event, never failed', async (t) => {
    await within(t, {}, async (w) => {
      const sender = createSender({ ...w.deps, sendMail: () => Promise.reject(new Error('boom')) })
      valueOf(sender.approve('app-1', 'initial'))
      await sender.settled()
      assert.equal(appOf(w.db).sends[0]?.state, 'send-unknown')
      assert.equal(appOf(w.db).state, 'send-unknown')
      assert.deepEqual(eventsOf(w.db).filter((e) => e.kind === 'send-unknown').map((e) => e.data), [{ kind: 'initial' }])
      assert.ok(!w.lines.join('\n').includes('ada@acme.example'))
    })
  })

  test('a logger that throws leaves no unhandled rejection, and settled() resolves', async (t) => {
    await within(t, {}, async (w) => {
      const log = { info: () => {}, warn: () => {}, error: () => { throw new Error('the log is gone') } }
      const seen = await unhandled(async () => {
        const sender = createSender({ ...w.deps, log, sendMail: () => Promise.reject(new Error('boom')) })
        valueOf(sender.approve('app-1', 'initial'))
        await sender.settled()
      })
      assert.deepEqual(seen, [])
    })
  })
})
