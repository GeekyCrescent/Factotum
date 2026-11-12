/**
 * Doubles for the tests: a mockup, a clock, a log, timers and a notifier. Not shipped behaviour, so
 * the coverage of the package leaves it out (`src/test-*.ts`).
 */

import type { Logger, NotificationMessage, Notifier, Timers } from '@factotum/core'
import type { Mockup, StageId, Step } from './types.ts'

export const NOW = new Date('2026-11-12T00:00:00.000Z')
export const SESSION = '0192f3a4-5b6c-7d8e-9f01-23456789abcd'
export const OTHER_SESSION = '0192f3a4-5b6c-7d8e-9f01-23456789abce'

export function step(overrides: Partial<Step> = {}): Step {
  return { status: 'locked', version: 0, history: [], ...overrides }
}

export function mockup(overrides: Partial<Mockup> & { readonly id: string }): Mockup {
  const stages: Record<StageId, Step> = {
    brief: step({ status: 'ready' }),
    concepts: step(),
    plan: step(),
    build: step(),
    deliver: step(),
  }
  return {
    name: `mockup ${overrides.id}`,
    client: 'Acme',
    project: 'acme',
    vaultDir: '/vault/01-projects/acme/mockup',
    workDir: '/work/Acme',
    buildSiteId: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    stages,
    changes: [],
    inputs: [],
    urls: {},
    status: 'open',
    ...overrides,
  }
}

/** A mockup with one stage replaced. */
export function withStep(m: Mockup, id: StageId, patch: Partial<Step>): Mockup {
  return { ...m, stages: { ...m.stages, [id]: { ...m.stages[id], ...patch } } }
}

export interface CapturedLog extends Logger {
  readonly lines: string[]
}

export function captureLog(): CapturedLog {
  const lines: string[] = []
  const write = (level: string) => (message: string) => void lines.push(`${level} ${message}`)
  return { lines, info: write('info'), warn: write('warn'), error: write('error') }
}

export interface CapturedNotify extends Notifier {
  readonly sent: NotificationMessage[]
}

export function captureNotify(reachable = true): CapturedNotify {
  const sent: NotificationMessage[] = []
  return {
    sent,
    canReach: () => reachable,
    send: async (message) => {
      sent.push(message)
    },
  }
}

/** Timers a test fires by hand, by delay. Intervals stay armed after firing; timeouts do not. */
export interface ManualTimers {
  readonly timers: Timers
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

/** Poll, do not guess a delay (CLAUDE.md §7). */
export async function eventually(check: () => boolean | Promise<boolean>, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
