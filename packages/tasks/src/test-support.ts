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

/** Timers a test fires by hand, by delay. Intervals stay armed after firing; timeouts do not. */
export interface ManualTimers {
  readonly timers: Timers
  /** Fires every pending timer whose delay is `ms` (or every one, without `ms`). Returns how many. */
  readonly fire: (ms?: number) => number
  readonly pending: () => readonly number[]
}

export function manualTimers(): ManualTimers {
  const waiting = new Map<symbol, { readonly fn: () => void; readonly ms: number; readonly repeat: boolean }>()
  const arm = (repeat: boolean) => (fn: () => void, ms: number) => {
    const key = Symbol('timer')
    waiting.set(key, { fn, ms, repeat })
    return { [Symbol.dispose]: () => void waiting.delete(key) }
  }
  return {
    timers: { setTimeout: arm(false), setInterval: arm(true) },
    fire: (ms) => {
      const due = [...waiting.entries()].filter(([, timer]) => ms === undefined || timer.ms === ms)
      for (const [key, timer] of due) {
        if (!timer.repeat) waiting.delete(key)
        timer.fn()
      }
      return due.length
    },
    pending: () => [...waiting.values()].map((timer) => timer.ms),
  }
}

/** Real timers, unref'd, the way the kernel hands them out. */
export const realTimers: Timers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms)
    handle.unref()
    return { [Symbol.dispose]: () => clearInterval(handle) }
  },
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref()
    return { [Symbol.dispose]: () => clearTimeout(handle) }
  },
}

/** Poll, do not guess a delay (CLAUDE.md §7). */
export async function eventually(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
