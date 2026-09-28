/**
 * What the bar leaves out, a tap away: the conversation's title, what was run, when, for how long,
 * how many turns, where, and the session's id. The bar keeps only the project and its state.
 */

import type { EngineSetupView, SessionSummary } from '../types.ts'
import { clock, duration } from './format.ts'
import { titleOf } from './history.ts'

export function Details({
  id,
  summary,
  setup,
  now,
}: {
  readonly id: string
  readonly summary: SessionSummary | undefined
  readonly setup: EngineSetupView
  readonly now: number
}) {
  const entry = setup.catalog.find((e) => e.id === summary?.entryId)
  const path = setup.sites.find((site) => site.id === summary?.siteId)?.path
  const rows: readonly (readonly [string, string, boolean?])[] = [
    ['Conversation', titleOf(summary?.prompt)],
    ['Run', entry?.label ?? summary?.entryId ?? ''],
    ['Started', summary === undefined ? '' : started(summary.startedAt)],
    ['Duration', summary === undefined ? '' : duration(summary.startedAt, summary.endedAt, now)],
    ['Turns', summary === undefined ? '' : String(summary.turns)],
    ['Folder', path ?? '', true],
    ['Session', id, true],
  ]
  return (
    <dl class="s-details">
      {rows
        .filter(([, value]) => value !== '')
        .map(([key, value, mono]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd class={mono === true ? 'mono' : undefined}>{value}</dd>
          </div>
        ))}
    </dl>
  )
}

function started(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return `${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${clock(iso)}`
}
