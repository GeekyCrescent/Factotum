import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotificationMessage } from '@factotum/core'
import { BOARD_FILE, openBoardStore } from './board/store.ts'
import { createReminders, due, MISSED_AFTER_MS, noticeOf, REMINDER_TICK_MS } from './reminders.ts'
import { board, captureLog, eventually, manualTimers, NOW, task, ZONE } from './test-support.ts'
import type { Task } from './types.ts'

const MINUTE = 60_000
const at = (ms: number): string => new Date(NOW.getTime() + ms).toISOString()

// --- due(), pure (criteria 34–37) -----------------------------------------------------------

test('crit. 34: exactly at the hour it is due; a minute before it is not', () => {
  const now = task({ id: 'now', status: 'todo', remindAt: at(0) })
  const soon = task({ id: 'soon', status: 'todo', remindAt: at(MINUTE) })
  const result = due(board([now, soon]), NOW)
  assert.deepEqual(result.send.map((t) => t.id), ['now'])
  assert.deepEqual(result.missed, [])
})

test('crit. 36: 24 h minus a minute late is still sent; 24 h plus a minute is missed, and nothing is sent', () => {
  const late = task({ id: 'late', status: 'todo', remindAt: at(-(MISSED_AFTER_MS - MINUTE)) })
  const gone = task({ id: 'gone', status: 'todo', remindAt: at(-(MISSED_AFTER_MS + MINUTE)) })
  const result = due(board([late, gone]), NOW)
  assert.deepEqual(result.send.map((t) => t.id), ['late'])
  assert.deepEqual(result.missed.map((t) => t.id), ['gone'])
})

test('crit. 35 and 37: already sent, already missed, or in Done or Canceled — never again', () => {
  const sent = task({ id: 'sent', status: 'todo', remindAt: at(-MINUTE), remindedAt: at(-MINUTE) })
  const missed = task({ id: 'missed', status: 'todo', remindAt: at(-(MISSED_AFTER_MS + MINUTE)), reminderMissed: true })
  const done = task({ id: 'done', status: 'done', remindAt: at(-MINUTE) })
  const canceled = task({ id: 'canceled', status: 'canceled', remindAt: at(-MINUTE) })
  const result = due(board([sent, missed, done, canceled]), NOW)
  assert.deepEqual(result.send, [])
  assert.deepEqual(result.missed, [])
})

test('the notice: «Reminder», the title cut to 120, the card’s path and a tag of its own (guardrail 4)', () => {
  const notice = noticeOf(task({ id: 'abc', title: 'x'.repeat(200), remindAt: at(0) }))
  assert.equal(notice.title, 'Reminder')
  assert.equal(notice.body.length, 120)
  assert.equal(notice.path, '/m/tasks/abc')
  assert.equal(notice.tag, 'tasks-reminder-abc')
})

// --- the tick (J2) --------------------------------------------------------------------------

async function rig(t: { after: (fn: () => Promise<void>) => void }, cards: readonly Task[], send?: (message: NotificationMessage) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'tasks-reminders-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, BOARD_FILE), JSON.stringify(board(cards)), { mode: 0o600 })
  const log = captureLog()
  const opened = await openBoardStore({ dir, timeZone: ZONE, now: NOW, log })
  if (!opened.ok) throw new Error(opened.reason)
  const sent: NotificationMessage[] = []
  const timers = manualTimers()
  const reminders = createReminders({
    store: opened.store,
    now: () => NOW,
    timers: timers.timers,
    notify: { canReach: () => true, send: send ?? (async (message) => void sent.push(message)) },
    log,
  })
  return { store: opened.store, reminders, sent, timers, log, dir }
}

test('start arms one interval of REMINDER_TICK_MS and fires a first tick at once, without waiting for it', async (t) => {
  const { reminders, sent, timers } = await rig(t, [task({ id: 'r', status: 'todo', remindAt: at(-MINUTE) })])
  reminders.start()
  assert.deepEqual(timers.pending(), [REMINDER_TICK_MS])
  await eventually(() => sent.length === 1, 'the first tick sent it')
  assert.equal(sent[0]?.path, '/m/tasks/r')
})

test('the tick writes remindedAt and reminderMissed in one write BEFORE sending, so a send never repeats', async (t) => {
  const order: string[] = []
  let store: Awaited<ReturnType<typeof rig>>['store'] | undefined
  const r = await rig(
    t,
    [task({ id: 'r', status: 'todo', remindAt: at(-MINUTE) }), task({ id: 'm', status: 'todo', remindAt: at(-(MISSED_AFTER_MS + MINUTE)) })],
    async () => {
      order.push(store?.current().tasks.find((x) => x.id === 'r')?.remindedAt === null ? 'sent before the write' : 'sent after the write')
    },
  )
  store = r.store
  await r.reminders.tick()
  assert.deepEqual(order, ['sent after the write'])
  const cards = r.store.current().tasks
  assert.equal(cards.find((x) => x.id === 'r')?.remindedAt, NOW.toISOString())
  assert.equal(cards.find((x) => x.id === 'm')?.reminderMissed, true)
  // A second tick finds nothing to do.
  await r.reminders.tick()
  assert.equal(order.length, 1)
})

test('crit. 35: a restart halfway (the write landed, the send did not) does not send twice', async (t) => {
  const first = await rig(t, [task({ id: 'r', status: 'todo', remindAt: at(-MINUTE) })], async () => {
    throw new Error('the process died here')
  })
  await first.reminders.tick()
  await first.store.idle()
  const again = await openBoardStore({ dir: first.dir, timeZone: ZONE, now: NOW, log: captureLog() })
  if (!again.ok) throw new Error(again.reason)
  assert.deepEqual(due(again.store.current(), NOW).send, [])
})

test('a notify.send that takes 15 s does not hold start, nor the tick after it', async (t) => {
  let release: () => void = () => undefined
  const slow = new Promise<void>((resolve) => {
    release = resolve
  })
  const { reminders, timers } = await rig(t, [task({ id: 'r', status: 'todo', remindAt: at(-MINUTE) })], () => slow)
  const started = Date.now()
  reminders.start()
  assert.ok(Date.now() - started < 100, 'start returned at once')
  assert.equal(timers.fire(REMINDER_TICK_MS), 1)
  release()
  await reminders.stop()
})

test('a tick never throws, and the log carries no title (criterion 41)', async (t) => {
  const { reminders, log } = await rig(t, [task({ id: 'r', title: 'SECRET', status: 'todo', remindAt: at(-MINUTE) })], async () => {
    throw new Error('push service down')
  })
  await reminders.tick()
  assert.equal(log.lines.some((line) => line.includes('SECRET')), false)
  assert.ok(log.lines.some((line) => line.includes('reminder') && line.includes('r')))
})

test('stop disarms the interval', async (t) => {
  const { reminders, timers } = await rig(t, [])
  reminders.start()
  await reminders.stop()
  assert.deepEqual(timers.pending(), [])
})

test('with no device to reach, nothing is marked: the reminder stays due for when one subscribes', async (t) => {
  const r = await rig(t, [task({ id: 'r', status: 'todo', remindAt: at(-MINUTE) })])
  const unreachable = createReminders({
    store: r.store,
    now: () => NOW,
    timers: r.timers.timers,
    notify: { canReach: () => false, send: async () => undefined },
    log: r.log,
  })
  await unreachable.tick()
  assert.equal(r.store.current().tasks[0]?.remindedAt, null)
  assert.deepEqual(due(r.store.current(), NOW).send.map((x) => x.id), ['r'])
})
