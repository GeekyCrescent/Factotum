/**
 * What `GET /board` answers (design D3): the backlog and the open cycle, a count of triage, what is in
 * use for the filters, and where the cycles stand. Pure.
 *
 * Triage is COUNTED, not carried: it is not a column, and the board shows «Triage (N)» (criterion 19).
 * The cards of a closed cycle live in its history, not on the board.
 */

import { compareCycles, cycleOf, rangeOf } from '../cycle.ts'
import type { Board, BoardView, CycleId, CycleSummary, ProjectRef, Task } from '../types.ts'

function sortedUnique(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].sort()
}

function projectsOf(tasks: readonly Task[]): readonly ProjectRef[] {
  const byKey = new Map<string, ProjectRef>()
  for (const task of tasks) {
    if (task.project !== null) byKey.set(`${task.project.host ?? ''}/${task.project.siteId}`, task.project)
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, project]) => project)
}

function cardsOf(board: Board, cycle: CycleId): readonly Task[] {
  if (cycle === board.openCycle) {
    return board.tasks.filter((t) => t.status === 'backlog' || (t.status !== 'triage' && t.cycle === board.openCycle))
  }
  const closed = board.cycles.find((c) => c.id === cycle)
  return closed === undefined ? [] : [...closed.done, ...closed.canceled]
}

export function boardView(board: Board, now: Date, timeZone: string, filter: { readonly cycle?: CycleId } = {}): BoardView {
  const currentCycle = cycleOf(now, timeZone)
  return {
    timeZone,
    openCycle: board.openCycle,
    openRange: rangeOf(board.openCycle),
    currentCycle,
    needsClose: compareCycles(currentCycle, board.openCycle) > 0,
    tasks: cardsOf(board, filter.cycle ?? board.openCycle),
    triage: board.tasks.filter((t) => t.status === 'triage').length,
    areas: sortedUnique(board.tasks.flatMap((t) => (t.area === null ? [] : [t.area]))),
    labels: sortedUnique(board.tasks.flatMap((t) => t.labels)),
    projects: projectsOf(board.tasks),
  }
}

/** The history, newest first, with what each cycle did (criterion 18). */
export function cycleSummaries(board: Board): readonly CycleSummary[] {
  return [...board.cycles].reverse().map((cycle) => ({
    id: cycle.id,
    range: rangeOf(cycle.id),
    closedAt: cycle.closedAt,
    done: cycle.done.length,
    canceled: cycle.canceled.length,
    carried: cycle.carried.length,
  }))
}
