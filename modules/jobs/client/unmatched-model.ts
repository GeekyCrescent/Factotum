/**
 * The «Unmatched replies» of the tracker (spec 2026-11-12-postulaciones, tasks Q5; requirements crit.
 * 56; design D12 rule 4): what «Assign to…» offers, and the heading. Pure.
 */

import type { AssignOption, UnmatchedReply } from './contract.ts'

export interface AssignChoice {
  readonly id: string
  /** «Company — Role». */
  readonly label: string
  /** The reader matched the mail to it (rules 1–3), and Claude could not settle it. */
  readonly suggested: boolean
}

const labelOf = (app: AssignOption): string => (app.role === '' ? app.company : `${app.company} — ${app.role}`)

/** The reader's candidates first (those still offered), then the rest in the engine's order. */
export function assignChoices(reply: UnmatchedReply, applications: readonly AssignOption[]): readonly AssignChoice[] {
  const byId = new Map(applications.map((app) => [app.id, app]))
  const suggested = reply.candidates.flatMap((id) => {
    const app = byId.get(id)
    return app === undefined ? [] : [{ id, label: labelOf(app), suggested: true }]
  })
  const taken = new Set(suggested.map((choice) => choice.id))
  const rest = applications.filter((app) => !taken.has(app.id)).map((app) => ({ id: app.id, label: labelOf(app), suggested: false }))
  return [...suggested, ...rest]
}

export function unmatchedHeading(count: number): string | null {
  if (count === 0) return null
  return count === 1 ? 'Unmatched reply' : `${count} unmatched replies`
}
