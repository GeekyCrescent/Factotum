/**
 * The task board's client (spec 2026-10-14, design D11). No drawer of its own and the shell's bar on
 * top, like the inbox.
 *
 * WHAT `rest` MEANS: `''` the board; `cycles` the history; `cycles/<id>` one closed cycle; anything
 * else a card id, opened as a sheet over the board — the path a reminder's push will open (D6).
 * Triage (`triage`) arrives with the second cut.
 */

import './client.css'
import './cards.css'
import './sheets.css'
import { Board } from './board.tsx'
import type { ViewProps } from './contract.ts'
import { CycleDetail, Cycles } from './cycles.tsx'
import { safeDecode } from './model.ts'

const CYCLES = 'cycles'

function TasksView(props: ViewProps) {
  const { rest } = props
  if (rest === CYCLES) return <Cycles props={props} />
  if (rest.startsWith(`${CYCLES}/`)) return <CycleDetail key={rest} props={props} id={rest.slice(CYCLES.length + 1)} />
  // A malformed segment (`%E0%A4%A`) opens no card rather than blanking the screen.
  return <Board props={props} openTask={rest === '' ? undefined : safeDecode(rest)} />
}

// Its own bar (redesign A): the cycle and the week are the first line of the screen.
export const tasksClient = { id: 'tasks', View: TasksView, ownsTopBar: true }
