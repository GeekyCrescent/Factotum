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
  /**
   * The type of the subagent whose tool this was, when the GATE wrote the result for it (spec
   * 2026-10-01-subagentes-visibles). Optional, so every `Call` written before it still compiles.
   */
  readonly by?: string | undefined
}

/** A subagent the agent launched: where it started, and what closed it. */
export interface SubagentRow {
  readonly kind: 'subagent'
  /** The start's: the row sits where the subagent began. */
  readonly seq: number
  readonly task: string
  readonly agent: string
  readonly description: string
  readonly background: boolean
  readonly startedAt: string
  /** `undefined` only while no state has come after it: open, in the turn that is running. */
  readonly end:
    | { readonly kind: 'ended'; readonly at: string; readonly ok: boolean; readonly status: string; readonly summary: string }
    | { readonly kind: 'interrupted'; readonly at: string }
    | undefined
}

export type Row =
  | { readonly kind: 'message'; readonly seq: number; readonly role: 'user' | 'assistant'; readonly text: string }
  | Call
  | { readonly kind: 'fold'; readonly seq: number; readonly calls: readonly Call[]; readonly names: readonly string[] }
  | { readonly kind: 'state'; readonly seq: number; readonly at: string; readonly state: SessionState; readonly reason: string | undefined }
  | SubagentRow

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
  // A gate decision about a subagent's tool is not the main agent reading, and is never folded away.
  return call.by === undefined && READ_ONLY.has(call.name) && call.result?.ok === true
}

/** Each result goes to the oldest call of the same name still without one. */
function pair(events: readonly SessionEvent[]): readonly Row[] {
  const rows: Row[] = []
  const open = new Map<string, number[]>()
  // Subagents: the rows still open, by task, and the type of every subagent in the log — read up front,
  // because the gate's result for a subagent's tool can be written before its start: the hook comes over
  // HTTP and the start over stdout, and nothing orders the two.
  const openTasks = new Map<string, number>()
  const agents = new Map<string, string>()
  for (const event of events) if (event.kind === 'subagent' && event.phase === 'started') agents.set(event.task, event.agent)
  const hidden = subagentCalls(events)
  events.forEach((event, at) => {
    if (hidden.has(at)) return
    switch (event.kind) {
      case 'message':
        rows.push({ kind: 'message', seq: event.seq, role: event.role, text: event.text })
        break
      case 'state':
        // ANY state ends the turn a subagent belonged to: a terminal one closes what its turn left
        // open, and a `running` closes what stop() wrote after the terminal (spec 2026-10-01-subagentes,
        // requirements §0.12). Nothing open survives its turn, and a reply never reopens it.
        for (const index of openTasks.values()) {
          const row = rows[index]
          if (row?.kind === 'subagent') rows[index] = { ...row, end: { kind: 'interrupted', at: event.at } }
        }
        openTasks.clear()
        rows.push({ kind: 'state', seq: event.seq, at: event.at, state: event.state, reason: event.reason })
        break
      case 'subagent':
        if (event.phase === 'started') {
          // The translator never writes a second start for a task still open; an old log might.
          if (openTasks.has(event.task)) break
          openTasks.set(event.task, rows.length)
          rows.push({
            kind: 'subagent',
            seq: event.seq,
            task: event.task,
            agent: event.agent,
            description: event.description,
            background: event.background,
            startedAt: event.at,
            end: undefined,
          })
          break
        }
        {
          const index = openTasks.get(event.task)
          const row = index === undefined ? undefined : rows[index]
          if (index === undefined || row?.kind !== 'subagent') break
          rows[index] = { ...row, end: { kind: 'ended', at: event.at, ok: event.ok, status: event.status, summary: event.summary } }
          openTasks.delete(event.task)
        }
        break
      case 'tool':
        open.set(event.name, [...(open.get(event.name) ?? []), rows.length])
        rows.push({ kind: 'call', seq: event.seq, name: event.name, input: event.input, result: undefined })
        break
      case 'result': {
        const outcome = { ok: event.ok, summary: event.summary }
        // The gate wrote this for a SUBAGENT's tool, whose call is not in the log: it is its own row,
        // and it must never close a call of the main agent's that happens to share the name.
        if (event.task !== undefined) {
          rows.push({ kind: 'call', seq: event.seq, name: event.name, input: undefined, result: outcome, by: agents.get(event.task) ?? 'subagent' })
          break
        }
        const [index, ...rest] = open.get(event.name) ?? []
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
  })
  return rows
}

/** The tools a main agent launches a subagent with. */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])

/**
 * The positions of the `Agent` / `Task` events the subagent rows replace (criterion 19). A COUNT per
 * turn, not a pairing — the log keeps no id to pair by: a turn with `k` starts hides `k` of its calls,
 * and every successful result of those tools. A call whose result FAILED is never one of the `k`, and
 * its result is never hidden: a subagent that never started has nothing else to say so, and the call
 * shows whole, with its failure. A log with no subagent events at all hides nothing, so a log written
 * before them reads as it always did.
 */
function subagentCalls(events: readonly SessionEvent[]): ReadonlySet<number> {
  const hidden = new Set<number>()
  if (!events.some((event) => event.kind === 'subagent')) return hidden
  let turn: number[] = []
  const close = () => {
    const starts = turn.filter((at) => {
      const event = events[at]
      return event?.kind === 'subagent' && event.phase === 'started'
    }).length
    for (const at of startedCalls(events, turn).slice(0, starts)) hidden.add(at)
    if (starts > 0) {
      for (const at of turn) {
        const event = events[at]
        if (event?.kind === 'result' && event.ok && event.task === undefined && SUBAGENT_TOOLS.has(event.name)) hidden.add(at)
      }
    }
    turn = []
  }
  events.forEach((event, at) => {
    if (event.kind === 'state') close()
    else turn.push(at)
  })
  close()
  return hidden
}

/**
 * A turn's `Agent` / `Task` calls minus the ones whose result failed, paired the way `pair` pairs them:
 * each result to the oldest call of its name still without one. A failed call is the common way a
 * subagent does not start (an unknown type, tasks §M A3 (a)), and it must not take the place of one
 * that did.
 */
function startedCalls(events: readonly SessionEvent[], turn: readonly number[]): readonly number[] {
  const waiting = new Map<string, number[]>()
  const failed = new Set<number>()
  for (const at of turn) {
    const event = events[at]
    if (event?.kind === 'tool' && SUBAGENT_TOOLS.has(event.name)) {
      waiting.set(event.name, [...(waiting.get(event.name) ?? []), at])
    } else if (event?.kind === 'result' && event.task === undefined && SUBAGENT_TOOLS.has(event.name)) {
      const [call, ...rest] = waiting.get(event.name) ?? []
      waiting.set(event.name, rest)
      if (call !== undefined && !event.ok) failed.add(call)
    }
  }
  return turn.filter((at) => {
    const event = events[at]
    return event?.kind === 'tool' && SUBAGENT_TOOLS.has(event.name) && !failed.has(at)
  })
}
