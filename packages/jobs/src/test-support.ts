/**
 * Test-only helpers shared by this package's tests: timers a test fires by hand, a clock it moves,
 * a notifier that records, a log it can read, a base directory in temp, and polling instead of
 * guessing a delay (CLAUDE.md §7). Excluded from coverage (`src/test-*.ts`).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Logger, NotificationMessage, Notifier, Timers } from '@factotum/core'

export interface ManualTimers {
  readonly timers: Timers
  /** Fires every pending timeout whose delay is `ms` (or every one, without `ms`). */
  readonly fire: (ms?: number) => number
  /** Runs every interval whose period is `ms` (or every one, without `ms`) once. */
  readonly tick: (ms?: number) => number
  readonly pending: () => readonly number[]
}

export function manualTimers(): ManualTimers {
  const timeouts = new Map<symbol, { readonly fn: () => void; readonly ms: number }>()
  const intervals = new Map<symbol, { readonly fn: () => void; readonly ms: number }>()
  const arm = (into: typeof timeouts, kind: string) => (fn: () => void, ms: number): Disposable => {
    const key = Symbol(kind)
    into.set(key, { fn, ms })
    return { [Symbol.dispose]: () => void into.delete(key) }
  }
  return {
    timers: { setTimeout: arm(timeouts, 'timeout'), setInterval: arm(intervals, 'interval') },
    fire: (ms) => {
      const due = [...timeouts.entries()].filter(([, timer]) => ms === undefined || timer.ms === ms)
      for (const [key, timer] of due) {
        timeouts.delete(key)
        timer.fn()
      }
      return due.length
    },
    tick: (ms) => {
      const due = [...intervals.values()].filter((timer) => ms === undefined || timer.ms === ms)
      for (const timer of due) timer.fn()
      return due.length
    },
    pending: () => [...timeouts.values()].map((timer) => timer.ms),
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

export interface ManualClock {
  readonly now: () => Date
  readonly set: (at: Date | string) => void
  readonly advance: (ms: number) => void
}

/** A clock that only moves when the test says so. Each `now()` is a fresh `Date`. */
export function manualClock(start: Date | string = '2026-11-14T00:00:00.000Z'): ManualClock {
  let at = new Date(start).getTime()
  return {
    now: () => new Date(at),
    set: (to) => void (at = new Date(to).getTime()),
    advance: (ms) => void (at += ms),
  }
}

export interface RecordingNotifier {
  readonly notify: Notifier
  readonly sent: NotificationMessage[]
}

export function recordingNotifier(reachable = true): RecordingNotifier {
  const sent: NotificationMessage[] = []
  return {
    sent,
    notify: {
      canReach: () => reachable,
      send: async (message) => void sent.push(message),
    },
  }
}

export interface CapturedLog {
  readonly log: Logger
  readonly lines: string[]
}

export function capturedLog(): CapturedLog {
  const lines: string[] = []
  return {
    lines,
    log: {
      info: (message) => void lines.push(`info ${message}`),
      warn: (message) => void lines.push(`warn ${message}`),
      error: (message) => void lines.push(`error ${message}`),
    },
  }
}

export interface TempBase {
  readonly dir: string
  readonly [Symbol.dispose]: () => void
}

/** A fresh directory under the OS temp dir, removed on dispose (`using base = tempBase()`). */
export function tempBase(prefix = 'jobs-test-'): TempBase {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }) }
}

export async function eventually(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
