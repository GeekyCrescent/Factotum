/**
 * The log, as rows: each tool call paired with its result, and long runs of reading folded into
 * one row (spec 2026-09-18, criterion 16). Pure; no DOM (guardrail 11).
 *
 * WHAT FOLDS: more than FOLD_OVER calls in a row that only READ and came back fine. What never
 * folds, and splits a run: anything that writes or runs (`Edit`, `Write`, `Bash`), any failure,
 * any call still waiting for its result, and a message.
 */

import type { SessionEvent, SessionState } from '../types.ts'

export const READ_ONLY: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS'])
export const FOLD_OVER = 5

export interface Call {
  readonly kind: 'call'
  readonly seq: number
  readonly name: string
  readonly input: unknown
  /** `undefined` while the call is waiting for its result. */
  readonly result: { readonly ok: boolean; readonly summary: string } | undefined
}

export type Row =
  | { readonly kind: 'message'; readonly seq: number; readonly role: 'user' | 'assistant'; readonly text: string }
  | Call
  | { readonly kind: 'fold'; readonly seq: number; readonly calls: readonly Call[]; readonly names: readonly string[] }
  | { readonly kind: 'state'; readonly seq: number; readonly at: string; readonly state: SessionState; readonly reason: string | undefined }

export function fold(events: readonly SessionEvent[]): readonly Row[] {
  const rows: Row[] = []
  let run: Call[] = []
  const flush = () => {
    if (run.length > FOLD_OVER) rows.push({ kind: 'fold', seq: run[0]!.seq, calls: run, names: [...new Set(run.map((c) => c.name))] })
    else rows.push(...run)
    run = []
  }
  for (const row of pair(events)) {
    if (row.kind === 'call' && foldable(row)) {
      run.push(row)
      continue
    }
    flush()
    rows.push(row)
  }
  flush()
  return rows
}

function foldable(call: Call): boolean {
  return READ_ONLY.has(call.name) && call.result?.ok === true
}

/** Each result goes to the oldest call of the same name still without one. */
function pair(events: readonly SessionEvent[]): readonly Row[] {
  const rows: Row[] = []
  const open = new Map<string, number[]>()
  for (const event of events) {
    switch (event.kind) {
      case 'message':
        rows.push({ kind: 'message', seq: event.seq, role: event.role, text: event.text })
        break
      case 'state':
        rows.push({ kind: 'state', seq: event.seq, at: event.at, state: event.state, reason: event.reason })
        break
      case 'tool':
        open.set(event.name, [...(open.get(event.name) ?? []), rows.length])
        rows.push({ kind: 'call', seq: event.seq, name: event.name, input: event.input, result: undefined })
        break
      case 'result': {
        const [index, ...rest] = open.get(event.name) ?? []
        const outcome = { ok: event.ok, summary: event.summary }
        const waiting = index === undefined ? undefined : rows[index]
        if (index === undefined || waiting?.kind !== 'call') {
          rows.push({ kind: 'call', seq: event.seq, name: event.name, input: undefined, result: outcome })
          break
        }
        open.set(event.name, rest)
        rows[index] = { ...waiting, result: outcome }
        break
      }
    }
  }
  return rows
}
