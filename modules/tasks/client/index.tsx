/**
 * The task board's client (spec 2026-10-14, design D11). No drawer of its own and the shell's bar on
 * top, like the inbox.
 *
 * WHAT `rest` MEANS: `''` the board; `cycles` the history; `cycles/<id>` one closed cycle; anything
 * else a card id, opened as a sheet over the board — the path a reminder's push will open (D6).
 * `triage` is the AI's inbox (E4), and `triage/<id>` a card of it open to edit; `next` is «What's
 * next?» as a sheet over the board (F2). A card id is a UUIDv7,
 * so it can never be one of these words.
 */

import './client.css'
import './cards.css'
import './sheets.css'
import './triage.css'
import './next.css'
import './agent.css'
import { Board } from './board.tsx'
import type { ViewProps } from './contract.ts'
import { CycleDetail, Cycles } from './cycles.tsx'
import { safeDecode } from './model.ts'
import { RelayGate } from './relay-gate.tsx'
import { Triage } from './triage.tsx'

const CYCLES = 'cycles'
const TRIAGE = 'triage'
const NEXT = 'next'

function TasksView(props: ViewProps) {
  // Relay mode (crit. 29b): asked alongside the screen, and the owner is taken to the board.
  return (
    <RelayGate props={props}>
      <Screen {...props} />
    </RelayGate>
  )
}

function Screen(props: ViewProps) {
  const { rest } = props
  if (rest === NEXT) return <Board props={props} openTask={undefined} asking />
  if (rest === TRIAGE) return <Triage props={props} editing={undefined} />
  if (rest.startsWith(`${TRIAGE}/`)) return <Triage props={props} editing={safeDecode(rest.slice(TRIAGE.length + 1))} />
  if (rest === CYCLES) return <Cycles props={props} />
  if (rest.startsWith(`${CYCLES}/`)) return <CycleDetail key={rest} props={props} id={rest.slice(CYCLES.length + 1)} />
  // A malformed segment (`%E0%A4%A`) opens no card rather than blanking the screen.
  return <Board props={props} openTask={rest === '' ? undefined : safeDecode(rest)} />
}

// Its own bar (redesign A): the cycle and the week are the first line of the screen.
export const tasksClient = { id: 'tasks', View: TasksView, ownsTopBar: true }
