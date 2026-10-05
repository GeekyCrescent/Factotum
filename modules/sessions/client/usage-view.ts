/**
 * What the «Skills» screen draws from `GET /skills` and `GET /skills/usage` (spec 2026-10-03-skills-a-mano,
 * D10): the used, the never used, the unsorted. Pure, so it is tested without a DOM.
 */

import { UNSORTED_LABEL, type SkillEntryView, type SkillsView } from '../skills/arrange.ts'
import type { UsageCount } from '../types.ts'

export interface UsageAnswer {
  readonly list: SkillsView['list']
  readonly counts: readonly UsageCount[]
}

const totalOf = (count: UsageCount): number => count.owner + count.agent

/** Used at least once, most first; the name settles a tie so the order does not jump between loads. */
export function usedRows(counts: readonly UsageCount[]): readonly UsageCount[] {
  return counts.filter((count) => totalOf(count) > 0).sort((a, b) => totalOf(b) - totalOf(a) || a.name.localeCompare(b.name))
}

export interface NeverUsedGroup {
  readonly label: string
  readonly entries: readonly SkillEntryView[]
}

/**
 * What the list shows and the period did not use, grouped as the list is. «Unsorted» is left out: it has its
 * own fold, and the note's groups are the reminder of what you chose to have.
 */
export function neverUsed(view: SkillsView, counts: readonly UsageCount[]): readonly NeverUsedGroup[] {
  const used = new Set(usedRows(counts).map((count) => count.name))
  return view.groups
    .filter((group) => group.label !== UNSORTED_LABEL)
    .map((group) => ({ label: group.label, entries: group.entries.filter((entry) => !used.has(entry.name)) }))
    .filter((group) => group.entries.length > 0)
}

export const unsortedOf = (view: SkillsView): readonly SkillEntryView[] => view.groups.find((group) => group.label === UNSORTED_LABEL)?.entries ?? []

/** «you 3 · agent 1», leaving out the side that is zero. */
export function whoLine(count: UsageCount): string {
  const parts = [count.owner > 0 ? `you ${count.owner}` : undefined, count.agent > 0 ? `agent ${count.agent}` : undefined]
  return parts.filter((part) => part !== undefined).join(' · ')
}
