/**
 * The announced list × the owner's note × the pinned names → what the slash box and the Skills screen draw
 * (spec 2026-10-03-skills-a-mano, D4 and D6). PURE: no disk, no clock.
 *
 * THE CLI DECIDES WHAT EXISTS, THE NOTE ONLY ORDERS IT. A name in the note that the CLI does not announce
 * never comes out (it is `stale`), and without the list nothing comes out at all.
 */

import type { Announced } from '../types.ts'
import type { NoteRow, NotesRead } from './notes.ts'

export interface SkillEntryView {
  readonly name: string
  readonly kind: 'skill' | 'command' | 'agent'
  readonly why?: string
  readonly when?: string
}
export interface SkillsView {
  readonly list: { readonly state: 'unknown' } | { readonly state: 'known'; readonly since: string; readonly version?: string }
  readonly notes: { readonly state: NotesRead['state']; readonly reason?: string; readonly warnings: readonly string[] }
  /** "Pinned" first when there are pins, then the note's groups, then "Unsorted". */
  readonly groups: readonly { readonly label: string; readonly entries: readonly SkillEntryView[] }[]
  /** Named by the note, not announced by the CLI. */
  readonly stale: readonly string[]
}

export const PINNED_LABEL = 'Pinned'
export const UNSORTED_LABEL = 'Unsorted'

type Kind = SkillEntryView['kind']

/** D4: a skill, else a command; a row marked as agent looks only among agents. */
function resolve(list: Announced, name: string, agent: boolean): Kind | undefined {
  if (agent) return list.agents.includes(name) ? 'agent' : undefined
  if (list.skills.includes(name)) return 'skill'
  return list.commands.includes(name) ? 'command' : undefined
}

const keyOf = (entry: { readonly name: string; readonly kind: Kind }): string => `${entry.kind}:${entry.name}`

function entryOf(name: string, kind: Kind, row: NoteRow | undefined): SkillEntryView {
  return {
    name,
    kind,
    ...(row?.why === undefined ? {} : { why: row.why }),
    ...(row?.when === undefined ? {} : { when: row.when }),
  }
}

export function arrange(input: {
  readonly announced: Announced | undefined
  readonly notes: NotesRead
  readonly pinned: readonly string[]
}): SkillsView {
  const { announced: list, notes, pinned } = input
  const noteView = {
    state: notes.state,
    ...(notes.state !== 'ok' && notes.reason !== undefined ? { reason: notes.reason } : {}),
    warnings: notes.state === 'ok' ? notes.parsed.warnings : [],
  }
  if (list === undefined) return { list: { state: 'unknown' }, notes: noteView, groups: [], stale: [] }

  const known = { state: 'known' as const, since: list.since, ...(list.version === undefined ? {} : { version: list.version }) }
  const noteGroups = notes.state === 'ok' ? notes.parsed.groups : []

  // 1. The note's rows, resolved. What does not resolve is stale.
  const stale: string[] = []
  const resolved = noteGroups.map((group) => ({
    label: group.label,
    entries: group.rows.flatMap((row) => {
      const kind = resolve(list, row.name, row.agent)
      if (kind === undefined) {
        stale.push(row.name)
        return []
      }
      return [entryOf(row.name, kind, row)]
    }),
  }))

  // 2. Pins: resolved like an unmarked row, else as an agent. Note order first, then the rest alphabetical.
  const inNoteOrder = resolved.flatMap((group) => group.entries)
  const pinKeys = new Set<string>()
  for (const name of new Set(pinned)) {
    const kind = resolve(list, name, false) ?? resolve(list, name, true)
    if (kind !== undefined) pinKeys.add(keyOf({ name, kind }))
  }
  const fromNote = inNoteOrder.filter((entry) => pinKeys.has(keyOf(entry)))
  const noted = new Set(fromNote.map(keyOf))
  const extra = [...pinKeys]
    .filter((key) => !noted.has(key))
    .map((key): SkillEntryView => {
      const at = key.indexOf(':')
      return { name: key.slice(at + 1), kind: key.slice(0, at) as Kind }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  const pins = [...fromNote, ...extra]

  // 3. The groups: Pinned, the note's (without the pins), Unsorted.
  const groups = [
    { label: PINNED_LABEL, entries: pins },
    ...resolved.map((group) => ({ label: group.label, entries: group.entries.filter((entry) => !pinKeys.has(keyOf(entry))) })),
  ]
  const placed = new Set([...inNoteOrder.map(keyOf), ...pinKeys])
  const unsorted = [
    ...list.skills.map((name): SkillEntryView => ({ name, kind: 'skill' })),
    ...list.agents.map((name): SkillEntryView => ({ name, kind: 'agent' })),
  ].filter((entry) => !placed.has(keyOf(entry)))
  groups.push({ label: UNSORTED_LABEL, entries: unsorted })

  return { list: known, notes: noteView, groups: groups.filter((group) => group.entries.length > 0), stale }
}
