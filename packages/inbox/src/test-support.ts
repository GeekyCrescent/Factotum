/**
 * Test-only helpers shared by this package's tests: timers a test fires by hand, a log it can read,
 * and polling instead of guessing a delay (CLAUDE.md §7).
 */

import type { Logger, Timers } from '@factotum/core'

export interface ManualTimers {
  readonly timers: Timers
  /** Fires every pending timeout whose delay is `ms` (or every one, without `ms`). */
  readonly fire: (ms?: number) => number
  readonly pending: () => readonly number[]
}

export function manualTimers(): ManualTimers {
  const waiting = new Map<symbol, { readonly fn: () => void; readonly ms: number }>()
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const key = Symbol('timeout')
      waiting.set(key, { fn, ms })
      return { [Symbol.dispose]: () => void waiting.delete(key) }
    },
    setInterval: () => ({ [Symbol.dispose]: () => undefined }),
  }
  return {
    timers,
    fire: (ms) => {
      const due = [...waiting.entries()].filter(([, timer]) => ms === undefined || timer.ms === ms)
      for (const [key, timer] of due) {
        waiting.delete(key)
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

export async function eventually(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
