/**
 * Reminders by push, at an hour the owner chose (design D6; criteria 34–37).
 *
 * ONE INTERVAL, NOT A TIMEOUT PER REMINDER: a Node `setTimeout` cannot pass ~24.8 days and does not run
 * while the machine sleeps (requirements §0.5). Every `REMINDER_TICK_MS` the board is compared with the
 * clock, on the kernel's timers (CLAUDE.md §6).
 *
 * WRITTEN BEFORE SENT: one write marks `remindedAt` on what goes out and `reminderMissed` on what is
 * more than `MISSED_AFTER_MS` late, and only then are the notices sent. A restart in between loses at
 * most one notice, and never sends one twice (criterion 35): `notify.send` has no acknowledgement.
 *
 * AT START a first tick runs WITHOUT BEING AWAITED: `start` has ten seconds, and a backlog of notices
 * after a crash must not spend them. A tick never throws; every failure goes to the log, with ids.
 *
 * WHAT GOES TO THE PUSH (guardrail 4): «Reminder» and the title, cut to 120. Nothing else of the card.
 */

import type { Logger, NotificationMessage, Notifier, Timers } from '@factotum/core'
import type { BoardStore } from './board/store.ts'
import type { Board, Task } from './types.ts'

export const REMINDER_TICK_MS = 60_000
/** Later than this, a reminder is «missed» and not sent (criterion 36). */
export const MISSED_AFTER_MS = 24 * 60 * 60 * 1000
const MAX_BODY_CHARS = 120

const FINISHED = new Set(['done', 'canceled'])

/** What to send now, and what came too late to send. Pure. */
export function due(board: Board, now: Date): { readonly send: readonly Task[]; readonly missed: readonly Task[] } {
  const send: Task[] = []
  const missed: Task[] = []
  for (const card of board.tasks) {
    if (card.remindAt === null || card.remindedAt !== null || card.reminderMissed || FINISHED.has(card.status)) continue
    const at = Date.parse(card.remindAt)
    if (Number.isNaN(at) || at > now.getTime()) continue
    if (now.getTime() - at > MISSED_AFTER_MS) missed.push(card)
    else send.push(card)
  }
  return { send, missed }
}

/** The notice of one card: a tap opens it (`/m/tasks/<id>`), and its tag collapses a repeat. */
export function noticeOf(card: Task): NotificationMessage {
  return { title: 'Reminder', body: card.title.slice(0, MAX_BODY_CHARS), path: `/m/tasks/${encodeURIComponent(card.id)}`, tag: `tasks-reminder-${card.id}` }
}

export interface RemindersDeps {
  readonly store: BoardStore
  readonly now: () => Date
  readonly timers: Timers
  readonly notify: Notifier
  readonly log: Logger
}

export interface Reminders {
  readonly start: () => void
  /** One pass. Never rejects. */
  readonly tick: () => Promise<void>
  readonly stop: () => Promise<void>
}

export function createReminders(deps: RemindersDeps): Reminders {
  let interval: Disposable | undefined
  let running: Promise<void> | undefined

  const pass = async (): Promise<void> => {
    let picked: { send: readonly Task[]; missed: readonly Task[] } = { send: [], missed: [] }
    const written = await deps.store.change((board) => {
      const now = deps.now()
      picked = due(board, now)
      if (picked.send.length === 0 && picked.missed.length === 0) return { ok: false, error: { code: 'conflict', reason: 'nothing due' } }
      const sent = new Set(picked.send.map((card) => card.id))
      const missed = new Set(picked.missed.map((card) => card.id))
      const at = now.toISOString()
      const tasks = board.tasks.map((card) =>
        sent.has(card.id) ? { ...card, remindedAt: at } : missed.has(card.id) ? { ...card, reminderMissed: true } : card,
      )
      return { ok: true, value: { board: { ...board, tasks } } }
    })
    if (!written.ok) {
      if (written.error.code !== 'conflict') deps.log.warn(`reminders could not be marked (${written.error.code}); the next tick tries again`)
      return
    }
    for (const card of picked.missed) deps.log.info(`reminder of ${card.id} missed: more than 24 h late`)
    // After the write, and each on its own: one that fails does not hold the others.
    await Promise.all(
      picked.send.map(async (card) => {
        try {
          await deps.notify.send(noticeOf(card))
          deps.log.info(`reminder of ${card.id} sent`)
        } catch {
          deps.log.warn(`reminder of ${card.id} could not be sent`)
        }
      }),
    )
  }

  /** One pass at a time: a slow push must not let two passes pick the same card. */
  const tick = async (): Promise<void> => {
    if (running !== undefined) return
    running = pass()
      .catch(() => deps.log.error('a reminders tick failed unexpectedly'))
      .finally(() => {
        running = undefined
      })
    await running
  }

  return {
    start: () => {
      interval = deps.timers.setInterval(() => void tick(), REMINDER_TICK_MS)
      // Not awaited: `start` has ten seconds, and the notices after a crash must not spend them.
      void tick()
    },
    tick,
    stop: async () => {
      interval?.[Symbol.dispose]()
      interval = undefined
      await running
    },
  }
}
