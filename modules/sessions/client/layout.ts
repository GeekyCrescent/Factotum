/**
 * The drawer's arrangement of projects: the owner's categories, in order, each with its projects in
 * order, and the projects in none LOOSE AT THE BOTTOM, with no header. Pure, so every move has a
 * test; no DOM (guardrail 11).
 *
 * WHOLE, NEVER A DELTA. Every change here returns the complete layout the daemon stores with one
 * `POST project-layout`, and the array it sends is the one the drawer shows — categories first,
 * loose last — so the file on disk reads in the same order as the screen.
 *
 * A layout is the daemon's `ProjectLayout`: `order` is every project once, with its category.
 */

import type { CategoryEntry, ProjectLayout } from '../types.ts'
import type { Group } from './history.ts'

export type Layout = ProjectLayout

/** One run of projects under a category, or loose (`category: undefined`, always last). */
export interface Section {
  readonly category: string | undefined
  readonly ids: readonly string[]
}

/** Where a project goes: a section, and its index there once it has left where it was. */
export interface Place {
  readonly category: string | undefined
  readonly index: number
}

/**
 * From `GET projects`: its order, and each project's category — one that names no category counts
 * as none, so a hand edit that dangles puts the project loose rather than nowhere.
 */
export function layoutOf(
  projects: readonly { readonly id: string; readonly category: string | undefined }[],
  categories: readonly CategoryEntry[],
): Layout {
  const known = new Set(categories.map((c) => c.id))
  return {
    categories,
    order: projects.map((p) => ({ id: p.id, category: p.category !== undefined && known.has(p.category) ? p.category : undefined })),
  }
}

/**
 * A layout this screen is still sending, brought in line with the projects there are NOW: one that
 * went is dropped, one that came is loose at the end, where the daemon puts a new project.
 */
export function reconcile(layout: Layout, ids: readonly string[]): Layout {
  const present = new Set(ids)
  const kept = layout.order.filter((placed) => present.has(placed.id))
  const placed = new Set(kept.map((p) => p.id))
  const added = ids.filter((id) => !placed.has(id)).map((id) => ({ id, category: undefined }))
  return { categories: layout.categories, order: [...kept, ...added] }
}

/** Every category in order, empty ones too — a drop target — and the loose projects last. */
export function sectionsOf(layout: Layout): readonly Section[] {
  const ids = (category: string | undefined) => layout.order.filter((placed) => placed.category === category).map((placed) => placed.id)
  return [...layout.categories.map((c) => ({ category: c.id, ids: ids(c.id) })), { category: undefined, ids: ids(undefined) }]
}

function fromSections(categories: readonly CategoryEntry[], sections: readonly Section[]): Layout {
  return { categories, order: sections.flatMap((section) => section.ids.map((id) => ({ id, category: section.category }))) }
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(value, max))
}

export function moveProject(layout: Layout, id: string, to: Place): Layout {
  if (!layout.order.some((placed) => placed.id === id)) return layout
  const sections = sectionsOf(layout).map((section) => ({ ...section, ids: section.ids.filter((other) => other !== id) }))
  const target = sections.find((section) => section.category === to.category)
  if (target === undefined) return layout
  const index = clamp(to.index, target.ids.length)
  const moved = sections.map((section) =>
    section === target ? { ...section, ids: [...section.ids.slice(0, index), id, ...section.ids.slice(index)] } : section,
  )
  return fromSections(layout.categories, moved)
}

/**
 * One step up or down, for the keyboard and the menu. Past the edge of its section it goes to the
 * near end of the next one, so steps alone can take a project anywhere, loose included.
 */
export function stepProject(layout: Layout, id: string, delta: -1 | 1): Layout {
  const sections = sectionsOf(layout)
  const at = sections.findIndex((section) => section.ids.includes(id))
  const section = sections[at]
  if (section === undefined) return layout
  const index = section.ids.indexOf(id) + delta
  if (index >= 0 && index < section.ids.length) return moveProject(layout, id, { category: section.category, index })
  const next = sections[at + delta]
  if (next === undefined) return layout
  return moveProject(layout, id, { category: next.category, index: delta < 0 ? next.ids.length : 0 })
}

export function moveCategory(layout: Layout, id: string, index: number): Layout {
  const moving = layout.categories.find((c) => c.id === id)
  if (moving === undefined) return layout
  const rest = layout.categories.filter((c) => c.id !== id)
  const at = clamp(index, rest.length)
  const categories = [...rest.slice(0, at), moving, ...rest.slice(at)]
  return fromSections(categories, sectionsOf({ categories, order: layout.order }))
}

export function stepCategory(layout: Layout, id: string, delta: -1 | 1): Layout {
  const index = layout.categories.findIndex((c) => c.id === id)
  if (index < 0) return layout
  return moveCategory(layout, id, index + delta)
}

/** A new category, last among them; with `project`, that project moves into it. */
export function addCategory(layout: Layout, category: CategoryEntry, project: string | undefined = undefined): Layout {
  const added = fromSections([...layout.categories, category], sectionsOf(layout))
  return project === undefined ? added : moveProject(added, project, { category: category.id, index: Number.MAX_SAFE_INTEGER })
}

export function renameCategory(layout: Layout, id: string, name: string): Layout {
  return { ...layout, categories: layout.categories.map((c) => (c.id === id ? { ...c, name } : c)) }
}

/** The category goes; its projects NEVER do: they become loose, first among the loose, in order. */
export function removeCategory(layout: Layout, id: string): Layout {
  const sections = sectionsOf(layout)
  const freed = sections.find((section) => section.category === id)?.ids ?? []
  const kept = sections
    .filter((section) => section.category !== id)
    .map((section) => (section.category === undefined ? { ...section, ids: [...freed, ...section.ids] } : section))
  return fromSections(
    layout.categories.filter((c) => c.id !== id),
    kept,
  )
}

/**
 * An id no category has yet, in the daemon's shape (`c-` and base 36, well under 40). Random, not
 * typed: the owner only ever sees the name.
 */
export function newCategoryId(existing: readonly CategoryEntry[], random: () => number = Math.random): string {
  const taken = new Set(existing.map((c) => c.id))
  const base = `c-${Math.floor(random() * 36 ** 6).toString(36)}`
  let id = base
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`
  return id
}

// ---------------------------------------------------------------------------
// what the drawer draws
// ---------------------------------------------------------------------------

export type Block =
  | { readonly kind: 'group'; readonly group: Group }
  | { readonly kind: 'category'; readonly category: CategoryEntry; readonly groups: readonly Group[] }

/**
 * The drawer's groups in the owner's arrangement: what is not a project first (Needs you, Running),
 * then each category with its projects, then the loose ones. SEARCHING, a category with no match is
 * left out, as a project with none already is; otherwise an empty one stays, to be dropped into.
 */
export function arrange(groups: readonly Group[], layout: Layout, searching: boolean): readonly Block[] {
  const byProject = new Map(groups.flatMap((group) => (group.project === undefined ? [] : [[group.project.id, group] as const])))
  const groupsOf = (section: Section): readonly Group[] => section.ids.flatMap((id) => byProject.get(id) ?? [])
  const sections = sectionsOf(layout)
  const categories = layout.categories.flatMap((category): Block[] => {
    const inside = groupsOf(sections.find((section) => section.category === category.id) ?? { category: category.id, ids: [] })
    return searching && inside.length === 0 ? [] : [{ kind: 'category', category, groups: inside }]
  })
  const loose = groupsOf(sections[sections.length - 1] ?? { category: undefined, ids: [] })
  return [
    ...groups.filter((group) => group.project === undefined).map((group): Block => ({ kind: 'group', group })),
    ...categories,
    ...loose.map((group): Block => ({ kind: 'group', group })),
  ]
}

// ---------------------------------------------------------------------------
// where a drag lands
// ---------------------------------------------------------------------------

/** Something on screen a dragged project can land on, as measured when the pointer moved. */
export type Target =
  | { readonly kind: 'project'; readonly id: string; readonly top: number; readonly bottom: number }
  /** A category's header: into it, at its end — the one way into a folded or empty category. */
  | { readonly kind: 'category'; readonly id: string; readonly top: number; readonly bottom: number }
  /** The strip under everything: loose, at the end. */
  | { readonly kind: 'loose'; readonly top: number; readonly bottom: number }

export type Drop =
  | { readonly kind: 'before' | 'after'; readonly id: string }
  | { readonly kind: 'into'; readonly category: string | undefined }

/**
 * The target under the pointer, or the nearest one when it is in a gap between them. A project
 * splits at its middle: above it is before, below it is after.
 */
export function dropAt(targets: readonly Target[], y: number, dragged: string): Drop | undefined {
  const candidates = targets.filter((target) => !(target.kind === 'project' && target.id === dragged))
  const distance = (target: Target) => (y < target.top ? target.top - y : y > target.bottom ? y - target.bottom : 0)
  const nearest = candidates.reduce<Target | undefined>((best, target) => (best === undefined || distance(target) < distance(best) ? target : best), undefined)
  if (nearest === undefined) return undefined
  if (nearest.kind === 'category') return { kind: 'into', category: nearest.id }
  if (nearest.kind === 'loose') return { kind: 'into', category: undefined }
  return { kind: y < (nearest.top + nearest.bottom) / 2 ? 'before' : 'after', id: nearest.id }
}

/** A drop turned into a place in the layout, counted once the dragged project has left. */
export function placeOf(layout: Layout, dragged: string, drop: Drop): Place | undefined {
  const sections = sectionsOf(layout).map((section) => ({ ...section, ids: section.ids.filter((id) => id !== dragged) }))
  if (drop.kind === 'into') {
    const section = sections.find((s) => s.category === drop.category)
    return section === undefined ? undefined : { category: section.category, index: section.ids.length }
  }
  const section = sections.find((s) => s.ids.includes(drop.id))
  if (section === undefined) return undefined
  const index = section.ids.indexOf(drop.id)
  return { category: section.category, index: drop.kind === 'before' ? index : index + 1 }
}

/**
 * Where a dragged CATEGORY lands: before the first category whose middle is below the pointer,
 * counted without itself. `mids` are the other categories' middles, in order.
 */
export function categoryIndexAt(mids: readonly number[], y: number): number {
  const below = mids.findIndex((mid) => y < mid)
  return below < 0 ? mids.length : below
}

/** The same layout, or not: a drop where it started sends nothing. */
export function sameLayout(a: Layout, b: Layout): boolean {
  return (
    a.categories.length === b.categories.length &&
    a.categories.every((c, i) => c.id === b.categories[i]?.id && c.name === b.categories[i]?.name) &&
    a.order.length === b.order.length &&
    a.order.every((p, i) => p.id === b.order[i]?.id && p.category === b.order[i]?.category)
  )
}
