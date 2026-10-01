/**
 * What the project picker lists (2026-10-01): the launchable sites, under the owner's categories —
 * the drawer's, in the drawer's order — and the loose ones last, with no header. A search and a
 * scope narrow it. Pure, so every rule has a test; no DOM (guardrail 11).
 *
 * THE SITES DECIDE WHAT IS THERE, THE ARRANGEMENT ONLY WHERE. A site the arrangement does not know
 * yet (just added) is loose at the end; an arrangement entry with no launchable site is dropped. With
 * no arrangement at all — `GET projects` failed or is not back yet — the list is flat, never empty.
 */

import type { CategoryEntry, Color } from '../types.ts'
import { layoutOf, sectionsOf } from './layout.ts'

export interface ChoiceSite {
  readonly id: string
  readonly path: string
  readonly name: string | undefined
  readonly color: Color | undefined
}

export interface Arrangement {
  readonly categories: readonly CategoryEntry[]
  readonly projects: readonly { readonly id: string; readonly category: string | undefined }[]
}

/** Which part of the list: all of it, one category, or the projects in none. */
export type Scope = { readonly kind: 'all' } | { readonly kind: 'category'; readonly id: string } | { readonly kind: 'loose' }

export interface ChoiceGroup {
  /** `undefined`: the loose projects, always last. */
  readonly category: CategoryEntry | undefined
  readonly sites: readonly ChoiceSite[]
}

/** Case and accents do not count: «angeles» finds «Ángeles». */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

function words(query: string): readonly string[] {
  return fold(query).split(/\s+/).filter((word) => word !== '')
}

/** Every word somewhere in the name, the id, the folder or the category's name. */
function matches(site: ChoiceSite, category: CategoryEntry | undefined, wanted: readonly string[]): boolean {
  if (wanted.length === 0) return true
  const haystack = fold([site.name ?? '', site.id, site.path, category?.name ?? ''].join('\n'))
  return wanted.every((word) => haystack.includes(word))
}

function inScope(category: CategoryEntry | undefined, scope: Scope): boolean {
  if (scope.kind === 'all') return true
  if (scope.kind === 'loose') return category === undefined
  return category?.id === scope.id
}

function arranged(sites: readonly ChoiceSite[], arrangement: Arrangement | undefined): readonly ChoiceGroup[] {
  if (arrangement === undefined) return [{ category: undefined, sites }]
  const byId = new Map(sites.map((site) => [site.id, site]))
  const named = new Map(arrangement.categories.map((category) => [category.id, category]))
  const placed = new Set<string>()
  const groups = sectionsOf(layoutOf(arrangement.projects, arrangement.categories)).map((section) => {
    const inSection = section.ids.flatMap((id) => {
      const site = byId.get(id)
      if (site === undefined) return []
      placed.add(id)
      return [site]
    })
    return { category: section.category === undefined ? undefined : named.get(section.category), sites: inSection }
  })
  const unknown = sites.filter((site) => !placed.has(site.id))
  return groups.map((group) => (group.category === undefined ? { ...group, sites: [...group.sites, ...unknown] } : group))
}

export function choiceGroupsOf(
  sites: readonly ChoiceSite[],
  arrangement: Arrangement | undefined,
  query: string,
  scope: Scope,
): readonly ChoiceGroup[] {
  const wanted = words(query)
  return arranged(sites, arrangement)
    .filter((group) => inScope(group.category, scope))
    .map((group) => ({ ...group, sites: group.sites.filter((site) => matches(site, group.category, wanted)) }))
    .filter((group) => group.sites.length > 0)
}

/** What Enter in the search picks. */
export function firstChoice(groups: readonly ChoiceGroup[]): ChoiceSite | undefined {
  return groups[0]?.sites[0]
}
