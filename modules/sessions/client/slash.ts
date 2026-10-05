/**
 * The `/` list of the box (spec 2026-10-03-skills-a-mano, D8). PURE: no DOM, no fetch.
 *
 * ONLY A `/` AT POSITION 0 COUNTS (requirements §0.5): the CLI expands `/skill` at the start of the text
 * and nowhere else, so `src/app` or `ver /etc` never open the list. Like `@`, the token is read from the
 * text and the caret, never from a key.
 */

import type { SkillEntryView, SkillsView } from '../skills/arrange.ts'

const BLANK = /\s/

// ---------------------------------------------------------------------------
// The token (criterion 21)
// ---------------------------------------------------------------------------

export interface SlashToken {
  /** What follows the `/` up to the first blank. */
  readonly query: string
  /** The index of the first blank, or the text's length: the token is `text[0, end)`. */
  readonly end: number
}

/** `/` at position 0, the caret inside the first word (from just after the `/` to its end). */
export function slashTokenAt(text: string, caret: number): SlashToken | undefined {
  if (text[0] !== '/') return undefined
  let end = 1
  while (end < text.length && !BLANK.test(text[end] as string)) end += 1
  if (caret < 1 || caret > end) return undefined
  return { query: text.slice(1, end), end }
}

// ---------------------------------------------------------------------------
// The rows (criterion 23)
// ---------------------------------------------------------------------------

export type SlashRow =
  | { readonly kind: 'group'; readonly label: string }
  | { readonly kind: 'entry'; readonly entry: SkillEntryView }

const fold = (text: string): string => text.normalize('NFC').toLowerCase()

/** 0: the name, or what follows its last `:`, starts with the query. 1: contains it. `undefined`: no match. */
function rankOf(name: string, query: string): 0 | 1 | undefined {
  const full = fold(name)
  const tail = full.slice(full.lastIndexOf(':') + 1)
  if (full.startsWith(query) || tail.startsWith(query)) return 0
  return full.includes(query) ? 1 : undefined
}

/**
 * No query: the view's groups as they are, each header before its entries — or, with a chip chosen, only
 * that group's entries. A query: no groups and no chip, the entries whose name matches — starts-with
 * first, then contains, ties in view order. NEVER the why/when lines: a «when» that mentions «spec» would
 * fill the list.
 */
export function slashRows(view: SkillsView, query: string, group?: string): readonly SlashRow[] {
  if (query === '') {
    const only = view.groups.find((candidate) => candidate.label === group)
    if (only !== undefined) return only.entries.map((entry) => ({ kind: 'entry', entry }) as const)
    return view.groups.flatMap((group) => [
      { kind: 'group', label: group.label } as const,
      ...group.entries.map((entry) => ({ kind: 'entry', entry }) as const),
    ])
  }
  const wanted = fold(query)
  const ranked = view.groups
    .flatMap((group) => group.entries)
    .flatMap((entry, order) => {
      const rank = rankOf(entry.name, wanted)
      return rank === undefined ? [] : [{ entry, rank, order }]
    })
  return ranked.sort((a, b) => a.rank - b.rank || a.order - b.order).map(({ entry }) => ({ kind: 'entry', entry }))
}

// ---------------------------------------------------------------------------
// The group chips: one group at a time instead of scrolling through all of them
// ---------------------------------------------------------------------------

/** The chips after «All»: the view's groups in order, without one the pins left empty. */
export function slashGroups(view: SkillsView): readonly string[] {
  return view.groups.filter((group) => group.entries.length > 0).map((group) => group.label)
}

/**
 * ← and →: `undefined` is «All», before the first group. It stops at both ends rather than wrapping,
 * so holding a key lands on an end, never back where it started.
 */
export function stepGroup(groups: readonly string[], current: string | undefined, step: 1 | -1): string | undefined {
  const at = current === undefined ? -1 : groups.indexOf(current)
  const next = Math.min(groups.length - 1, Math.max(-1, at + step))
  return next < 0 ? undefined : groups[next]
}

/** What a row shows under the name: `when`, else `why`, else nothing (criterion 22). */
export function rowText(entry: SkillEntryView): string | undefined {
  return entry.when ?? entry.why
}

// ---------------------------------------------------------------------------
// What is inserted (criteria 24, 25)
// ---------------------------------------------------------------------------

export type Insertion =
  /** Replaces `text[0, end)`. The trailing space is the one `applyInsertion` may drop. */
  | { readonly kind: 'text'; readonly text: string }
  /** Removes the token: the launch box's chip carries the agent. */
  | { readonly kind: 'agent'; readonly name: string }

export function insertionFor(entry: SkillEntryView, mode: 'launch' | 'reply'): Insertion {
  if (entry.kind !== 'agent') return { kind: 'text', text: `/${entry.name} ` }
  return mode === 'launch' ? { kind: 'agent', name: entry.name } : { kind: 'text', text: `Use the ${entry.name} agent to ` }
}

/**
 * The new text and where the caret goes: always just behind the insertion's space, so the token is
 * over. One space is written, unless a blank already follows — then that one is the space.
 */
export function applyInsertion(text: string, end: number, insertion: Insertion): { readonly text: string; readonly caret: number } {
  const rest = text.slice(end)
  if (insertion.kind === 'agent') return { text: rest.trimStart(), caret: 0 }
  const written = BLANK.test(rest[0] ?? 'x') ? insertion.text.trimEnd() : insertion.text
  return { text: written + rest, caret: insertion.text.length }
}
