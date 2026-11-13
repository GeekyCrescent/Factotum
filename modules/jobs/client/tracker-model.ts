/**
 * The tracker of this cut, minimal (spec 2026-11-12-postulaciones, task R7; design D15 «Tracker»;
 * requirements crit. 63): the counters and «Start review (N)». The list and the rest are T2a's. Pure.
 *
 * «START» NEVER ARMS OVER AN OPEN BATCH: `startBatch` closes the open one (R2), so with one open the
 * button continues it — the owner's place in it, and what was decided, are kept.
 */

import type { Overview } from './contract.ts'

export interface Counter {
  readonly label: string
  readonly value: number
}

export function countersOf(overview: Overview): readonly Counter[] {
  const { counts } = overview
  return [
    { label: 'To review', value: counts.toReview },
    { label: 'Approved, not sent', value: counts.approvedNotSent },
    { label: 'Sent', value: counts.sent },
    { label: 'Awaiting reply', value: counts.awaitingReply },
    { label: 'Interviews', value: counts.interviews },
    { label: 'Offers', value: counts.offers },
  ]
}

export interface Start {
  readonly label: string
  readonly enabled: boolean
  /** `POST /batch` before going to the review; false: just go, the open batch is there. */
  readonly arms: boolean
}

export function startOf(overview: Overview): Start {
  if (overview.batchOpen) return { label: 'Continue review', enabled: true, arms: false }
  return { label: `Start review (${overview.reviewable})`, enabled: overview.reviewable > 0, arms: true }
}
