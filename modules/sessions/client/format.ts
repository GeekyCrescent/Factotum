/**
 * Words and numbers for the sessions screens: relative times, cuts, the preview's note. Pure, with
 * `now` injected, so every one has a test (spec 2026-09-18, design D5). No DOM (guardrail 11).
 */

import type { AskPreview, SessionState } from '../types.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "now", "5m", "3h", "2d". `''` for a date that cannot be read. */
export function ago(iso: string, now: number): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const ms = Math.max(0, now - at)
  if (ms < MINUTE) return 'now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`
  return `${Math.floor(ms / DAY)}d`
}

/** "45s", "3m 12s", "1h 4m". Without an end, it counts to `now`. */
export function duration(fromIso: string, toIso: string | undefined, now: number): string {
  const from = Date.parse(fromIso)
  const to = toIso === undefined ? now : Date.parse(toIso)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return ''
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

/** The local "HH:MM" of a deadline. */
export function clock(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

export function isToday(iso: string, now: number): boolean {
  const at = new Date(iso)
  const today = new Date(now)
  return (
    at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate()
  )
}

export function fileName(path: string): string {
  const parts = path.split('/').filter((part) => part !== '')
  return parts[parts.length - 1] ?? path
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export interface PreviewText {
  readonly head: string
  readonly tail: string
  /** "showing 2,000 of 48,213 characters", only when something was left out. */
  readonly cut: string | undefined
  /** "3 edits", only for a MultiEdit. */
  readonly edits: string | undefined
}

export function previewText(preview: AskPreview): PreviewText {
  const shown = preview.head.length + preview.tail.length
  return {
    head: preview.head,
    tail: preview.tail,
    cut: preview.total > shown ? `showing ${count(shown)} of ${count(preview.total)} characters` : undefined,
    edits: preview.edits === null ? undefined : `${preview.edits} edit${preview.edits === 1 ? '' : 's'}`,
  }
}

/** The argument that says what a call did, in the order a reader looks for it. */
const TELLING = ['file_path', 'notebook_path', 'command', 'pattern', 'path', 'url', 'query', 'description'] as const

export function toolArg(input: unknown): string {
  if (input === null || typeof input !== 'object') return input === undefined ? '' : String(input)
  const fields = input as Record<string, unknown>
  for (const key of TELLING) {
    const value = fields[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return JSON.stringify(input)
}

const STATES: Readonly<Record<SessionState, string>> = {
  running: 'Running',
  finished: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export function stateLabel(state: SessionState): string {
  return STATES[state]
}

function count(n: number): string {
  return n.toLocaleString('en-US')
}
