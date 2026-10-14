/**
 * What the «What's next?» sheet computes, PURE so `node --test` reaches it (design D11; criteria 38–40).
 */

import type { NextResult, NextStatus, Task } from '../types.ts'
import { dayOf, shortDay } from './model.ts'

export interface NextRow {
  readonly task: Task
  readonly why: string
}

/** Each suggestion with its card. One finished or deleted since the answer is left out: it is not next. */
export function nextRows(items: NextResult['items'], tasks: readonly Task[]): readonly NextRow[] {
  const seen = new Set<string>()
  return items.flatMap((item) => {
    const task = tasks.find((t) => t.id === item.id)
    if (task === undefined || seen.has(task.id) || task.status === 'done' || task.status === 'canceled' || task.status === 'triage') return []
    seen.add(task.id)
    return [{ task, why: item.why }]
  })
}

/** «Today, 10:12», or «Thu 15 Oct, 10:12» when the answer is from another day. */
export function askedAt(iso: string, timeZone: string, today: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
  const weekday = dayOf(day).split(' ')[0] ?? ''
  return `${day === today ? 'Today' : `${weekday} ${shortDay(day)}`}, ${time}`
}

export type NextStage = 'never' | 'thinking' | 'failed' | 'answer'

export function nextStage(status: NextStatus): NextStage {
  if (status.running) return 'thinking'
  if (status.last !== null) return 'answer'
  return status.error === null ? 'never' : 'failed'
}
