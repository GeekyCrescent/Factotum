/**
 * What the Triage screen computes, PURE so `node --test` reaches it (design D11; criteria 19–23c):
 * whether a card is still being read, where it came from, and what the owner typed.
 */

import type { Task } from '../types.ts'
import { toClientHost, type Where } from './where.ts'

export type Reading = 'reading' | 'failed'

/** «Reading it…» while claude has it; «Couldn't parse» when it failed. `skipped` shows nothing (crit. 23b). */
export function readingOf(task: Task): Reading | undefined {
  if (task.source.kind !== 'capture') return undefined
  if (task.source.parse === 'pending') return 'reading'
  return task.source.parse === 'failed' ? 'failed' : undefined
}

/** The screen polls while this is true, and stops when it is not (crit. 23c). */
export function anyReading(tasks: readonly Task[]): boolean {
  return tasks.some((task) => readingOf(task) === 'reading')
}

export interface Source {
  readonly kind: 'captured' | 'agent' | 'owner'
  readonly label: string
}

/**
 * Where a card came from (crit. 20). The agent's host is printed as STORED: `null` is the board's own
 * host, so it is left out. The link to the session is `originSessionOf`.
 */
export function sourceOf(task: Task): Source {
  const source = task.source
  if (source.kind === 'capture') return { kind: 'captured', label: 'Captured' }
  if (source.kind === 'agent') {
    return { kind: 'agent', label: `Agent · ${source.siteId}${source.host === null ? '' : ` on ${source.host}`}` }
  }
  return { kind: 'owner', label: 'Added by hand' }
}

/**
 * The session an agent's card came from, on its host as THIS app names it (`toClientHost`, crit. 30b):
 * what «Open the session» goes to (crit. 20). Nothing for any other source, nor before `where` exists.
 */
export function originSessionOf(task: Task, where: Where | undefined): { readonly sessionId: string; readonly host: string | undefined } | undefined {
  const source = task.source
  if (source.kind !== 'agent' || where === undefined) return undefined
  return { sessionId: source.sessionId, host: toClientHost(source.host, where) }
}

/** «You wrote: …» — only once claude rewrote the title; otherwise the title already is the text. */
export function wroteOf(task: Task): string | undefined {
  if (task.source.kind !== 'capture' || task.source.parse === 'pending') return undefined
  const raw = task.source.raw.trim()
  // A capital or a final full stop is not a rewrite: the owner would read their own words twice.
  const same = (text: string): string => text.trim().replace(/[.!?…]+$/u, '').toLocaleLowerCase()
  return same(raw) === same(task.title) ? undefined : raw
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export function agoOf(iso: string, now: Date): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const elapsed = now.getTime() - then
  if (elapsed < MINUTE_MS) return 'just now'
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`
  return `${Math.floor(elapsed / DAY_MS)} d ago`
}
