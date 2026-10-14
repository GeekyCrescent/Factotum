/**
 * Doubles for the tests: a card, a board, a clock, ids, timers and a log. Not shipped behaviour,
 * so the coverage of the package leaves it out (`src/test-*.ts`).
 */

import type { Logger, Notifier, Timers } from '@factotum/core'
import type { OpContext } from './board/ops.ts'
import type { Board, Task } from './types.ts'

export const ZONE = 'Australia/Sydney'
/** Wednesday 2026-10-14, 10:00 in Sydney: inside 2026-W42. */
export const NOW = new Date('2026-10-13T23:00:00Z')

export function task(overrides: Partial<Task> & { readonly id: string }): Task {
  return {
    title: `card ${overrides.id}`,
    notes: '',
    status: 'backlog',
    order: 'V',
    cycle: null,
    area: null,
    project: null,
    priority: 0,
    labels: [],
    estimate: null,
    due: null,
    remindAt: null,
    remindedAt: null,
    reminderMissed: false,
    subtasks: [],
    source: { kind: 'owner' },
    sessions: [],
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  }
}

export function board(tasks: readonly Task[] = [], overrides: Partial<Board> = {}): Board {
  return { version: 1, timeZone: ZONE, openCycle: '2026-W42', tasks, cycles: [], agentCounts: {}, next: null, ...overrides }
}

/** Ids `n1`, `n2`… in order, so a test can name what it has not created yet. */
export function counter(prefix = 'n'): () => string {
  let n = 0
  return () => `${prefix}${++n}`
}

export function ctx(now: Date = NOW): OpContext {
  return { now, timeZone: ZONE, newId: counter() }
}

export interface CapturedLog extends Logger {
  readonly lines: string[]
}

export function captureLog(): CapturedLog {
  const lines: string[] = []
  const write = (level: string) => (message: string) => void lines.push(`${level} ${message}`)
  return { lines, info: write('info'), warn: write('warn'), error: write('error') }
}

/** Timers a test advances by hand. */
export interface FakeTimers extends Timers {
  readonly armed: () => number
}

export function fakeTimers(): FakeTimers {
  let live = 0
  const handle = () => {
    live++
    let disposed = false
    return {
      [Symbol.dispose]: () => {
        if (!disposed) live--
        disposed = true
      },
    }
  }
  return { setInterval: () => handle(), setTimeout: () => handle(), armed: () => live }
}

export const silentNotify: Notifier = { canReach: () => false, send: async () => undefined }
