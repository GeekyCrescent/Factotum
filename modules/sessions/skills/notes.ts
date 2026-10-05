/**
 * The owner's skills note: read it, cache it by mtime, and parse its tables (spec 2026-10-03-skills-a-mano, D5).
 *
 * THE NOTE IS THE OWNER'S, NOT THE MODULE'S. Nothing here fixes it, and nothing here can fail loudly: a file
 * that is missing, too big or unreadable is a STATE the screen can say, never a throw, because `GET /skills`
 * must keep answering 200 with everything under "Unsorted" (criterion 15).
 */

import { readFile, stat } from 'node:fs/promises'
import { INVOKABLE_NAME } from '../config.ts'
import type { SkillsConfig } from './config.ts'

export const MAX_NOTES_BYTES = 256 * 1024
/** What `why` and `when` are cut to: they are the line under a name, not the description. */
const MAX_CELL_CHARS = 200

export interface NoteRow {
  readonly name: string
  readonly agent: boolean
  readonly why: string | undefined
  readonly when: string | undefined
}
export interface NoteGroup {
  readonly label: string
  readonly rows: readonly NoteRow[]
}
export interface ParsedNotes {
  readonly groups: readonly NoteGroup[]
  readonly warnings: readonly string[]
}

export type NotesRead =
  | { readonly state: 'off' | 'invalid' | 'missing' | 'too-large' | 'unreadable'; readonly reason?: string }
  | { readonly state: 'ok'; readonly parsed: ParsedNotes }

// ---------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------

const FENCE = /^\s*```/
const HEADING = /^(#{2,3})\s+(.*\S)\s*$/
/** `|---|:-:|` and nothing else. */
const SEPARATOR_CELL = /^:?-+:?$/
const WHY_HEADER = /para qu[eé]/i
const WHEN_HEADER = /cu[aá]ndo/i
const AGENT_MARK = /\((?:agente|agent)\)/i
const FIRST_CODE_SPAN = /`([^`]+)`/

/** Plain text of a cell or a heading: no links, emphasis or code marks, one line, trimmed. */
function stripMarkdown(text: string): string {
  return text
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A bare `|` splits, `\|` is a literal one. The outer pipes of the line are not cells. */
function splitCells(line: string): readonly string[] {
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  return body.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim())
}

const isSeparator = (line: string | undefined): boolean => {
  if (line === undefined || !line.trim().startsWith('|')) return false
  const cells = splitCells(line)
  return cells.length > 0 && cells.every((cell) => SEPARATOR_CELL.test(cell))
}

const optionalCell = (cells: readonly string[], index: number): string | undefined => {
  const text = stripMarkdown(cells[index] ?? '').slice(0, MAX_CELL_CHARS).trim()
  return text === '' ? undefined : text
}

/** The name of a row, or why it has none (rule 5). */
function nameOf(firstCell: string): { readonly name: string } | { readonly problem: string } {
  const span = FIRST_CODE_SPAN.exec(firstCell)?.[1]
  if (span === undefined) return { problem: 'no name between backticks' }
  const name = (span.trim().replace(/^\//, '').split(/\s/)[0]) ?? ''
  return INVOKABLE_NAME.test(name) ? { name } : { problem: 'not a name the CLI can be given' }
}

export function parseNotes(text: string): ParsedNotes {
  const lines = text.split(/\r?\n/)
  const groups: NoteGroup[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  let label: string | undefined
  let rows: NoteRow[] = []
  let inFence = false

  const closeGroup = (): void => {
    if (label !== undefined && rows.length > 0) groups.push({ label, rows })
    rows = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || line.trimStart().startsWith('>')) continue

    const heading = HEADING.exec(line)
    if (heading !== null) {
      closeGroup()
      label = stripMarkdown(heading[2]!)
      continue
    }

    if (!line.trim().startsWith('|') || !isSeparator(lines[index + 1])) continue

    // A table: header at `index`, separator after it, rows until a line that is not one.
    const header = splitCells(line)
    const tableLine = index + 1
    let end = index + 2
    while (end < lines.length && lines[end]!.trim().startsWith('|')) end += 1
    const body = lines.slice(index + 2, end)
    index = end - 1

    if (label === undefined) {
      warnings.push(`a table before the first heading was ignored (line ${tableLine})`)
      continue
    }
    const whyAt = header.findIndex((cell) => WHY_HEADER.test(cell))
    const whenAt = header.findIndex((cell) => WHEN_HEADER.test(cell))
    if (whyAt < 0 || whenAt < 0) continue

    for (const rowLine of body) {
      const cells = splitCells(rowLine)
      const first = cells[0] ?? ''
      const named = nameOf(first)
      if ('problem' in named) {
        warnings.push(`a row was skipped in "${label}": ${named.problem} (${stripMarkdown(first).slice(0, 40)})`)
        continue
      }
      const agent = AGENT_MARK.test(first)
      const key = `${agent ? 'agent' : 'any'}:${named.name}`
      if (seen.has(key)) {
        warnings.push(`"${named.name}" appears more than once; only the first row counts`)
        continue
      }
      seen.add(key)
      rows.push({ name: named.name, agent, why: optionalCell(cells, whyAt), when: optionalCell(cells, whenAt) })
    }
  }
  closeGroup()
  return { groups, warnings }
}

// ---------------------------------------------------------------------------
// Reading, with a cache by mtime
// ---------------------------------------------------------------------------

const codeOf = (error: unknown): string => (error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown')

export function createNotes(config: SkillsConfig): { readonly read: () => Promise<NotesRead> } {
  let cached: { readonly mtimeMs: number; readonly size: number; readonly result: NotesRead } | undefined

  const readFresh = async (file: string): Promise<NotesRead> => {
    try {
      const info = await stat(file)
      if (info.size > MAX_NOTES_BYTES) return { state: 'too-large' }
      if (cached?.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.result
      const bytes = await readFile(file)
      // The file may have grown between the stat and the read.
      if (bytes.length > MAX_NOTES_BYTES) return { state: 'too-large' }
      const result: NotesRead = { state: 'ok', parsed: parseNotes(bytes.toString('utf8')) }
      cached = { mtimeMs: info.mtimeMs, size: info.size, result }
      return result
    } catch (error) {
      const code = codeOf(error)
      return code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable', reason: code }
    }
  }

  return {
    read: async () => {
      if (config.kind === 'off') return { state: 'off' }
      if (config.kind === 'invalid') return { state: 'invalid', reason: config.reason }
      return await readFresh(config.notes)
    },
  }
}
