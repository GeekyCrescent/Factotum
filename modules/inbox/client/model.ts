/**
 * Sorting and grouping a digest for the screen (spec 2026-10-05, D7, D9). Pure, no DOM: tested by
 * `node --test` and compiled by `modules/tsconfig.json` too.
 *
 * THE ORDER LIVES HERE, not in the file: the digest keeps entries as they arrived, so changing how
 * to-dos are ranked never needs a migration.
 */

import type { DigestEntry, Priority, Progress } from '../types.ts'

const RANK: Readonly<Record<Priority, number>> = { high: 0, medium: 1, low: 2 }

/** An `action` that arrived without a priority counts as `medium` (criterion 13). */
export function priorityOf(entry: DigestEntry): Priority {
  return entry.priority ?? 'medium'
}

/**
 * The to-dos, in the order of criterion 13: by priority, high first; then by due date, the nearest
 * first and those without one last; then by arrival, the oldest first — it has waited longest.
 */
export function todoOrder(entries: readonly DigestEntry[]): readonly DigestEntry[] {
  return entries
    .filter((entry) => entry.category === 'action')
    .slice()
    .sort((a, b) => {
      const byPriority = RANK[priorityOf(a)] - RANK[priorityOf(b)]
      if (byPriority !== 0) return byPriority
      if (a.due !== b.due) {
        if (a.due === undefined) return 1
        if (b.due === undefined) return -1
        return a.due < b.due ? -1 : 1
      }
      return Date.parse(a.date) - Date.parse(b.date)
    })
}

export interface SenderGroup {
  /** What the sender calls itself, or its address. */
  readonly sender: string
  readonly address: string
  readonly count: number
  /** At least one of its mails carried `List-Unsubscribe`. */
  readonly hasUnsubscribe: boolean
}

/** Unsubscribe recommendations, ONE ROW PER SENDER (criterion 15): most mails first. */
export function unsubscribeGroups(entries: readonly DigestEntry[]): readonly SenderGroup[] {
  const groups = new Map<string, SenderGroup>()
  for (const entry of entries) {
    if (entry.category !== 'unsubscribe') continue
    const { name, address } = splitFrom(entry.from)
    const known = groups.get(address)
    groups.set(address, {
      sender: known?.sender ?? (name || address),
      address,
      count: (known?.count ?? 0) + 1,
      hasUnsubscribe: (known?.hasUnsubscribe ?? false) || entry.unsubscribeHeader,
    })
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.sender.localeCompare(b.sender))
}

export interface Sections {
  readonly todo: readonly DigestEntry[]
  readonly unsubscribe: readonly SenderGroup[]
  readonly spam: readonly DigestEntry[]
  readonly info: readonly DigestEntry[]
  readonly unclassified: readonly DigestEntry[]
}

export function sectionsOf(entries: readonly DigestEntry[]): Sections {
  return {
    todo: todoOrder(entries),
    unsubscribe: unsubscribeGroups(entries),
    spam: entries.filter((entry) => entry.category === 'spam'),
    info: entries.filter((entry) => entry.category === 'info'),
    unclassified: entries.filter((entry) => entry.category === 'unclassified'),
  }
}

/** `"Ana Pérez" <ana@x.com>` → its two halves; a bare address is both. */
export function splitFrom(from: string): { readonly name: string; readonly address: string } {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from)
  if (match === null) return { name: '', address: from.trim().toLowerCase() }
  return { name: match[1]?.trim() ?? '', address: (match[2] ?? '').trim().toLowerCase() }
}

/** Under a to-do: sender · source · due · "seen last time" (criteria 14, 25). */
export function metaLine(entry: DigestEntry): string {
  const { name, address } = splitFrom(entry.from)
  return [name || address, entry.account, entry.due === undefined ? '' : `due ${entry.due}`, entry.seenLastTime ? 'seen last time' : '']
    .filter((part) => part !== '')
    .join(' · ')
}

/** What the screen says while a run goes on (criterion 18). */
export function progressText(progress: Progress | undefined): string {
  if (progress === undefined) return 'Starting…'
  if (progress.step === 'reading') {
    return progress.account === 0 ? 'Starting…' : `Reading ${progress.account} of ${progress.of} account${progress.of === 1 ? '' : 's'}…`
  }
  if (progress.step === 'classifying') return `Classifying batch ${progress.batch} of ${progress.of}…`
  return 'Saving…'
}

/** 41 234 → "41.2k"; under a thousand, as is. */
export function tokens(count: number): string {
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`
}

export function seconds(ms: number): string {
  const total = Math.round(ms / 1000)
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${total % 60} s`
}

export function dollars(usd: number): string {
  return `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`
}
