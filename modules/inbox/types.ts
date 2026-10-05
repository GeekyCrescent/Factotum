/**
 * The shape of the capability this module consumes, DECLARED HERE AND NOWHERE ELSE IN THIS MODULE
 * (spec 2026-10-05, D1; requirements §7). The same arrangement as `modules/sessions/types.ts`, whose
 * header explains it; this is the third place that uses it, and ADR-0018 records that.
 *
 * Imports nothing but `@factotum/core` (CLAUDE.md §1). The two declarations meet at one assignment in
 * `packages/cli/src/main.ts`, which catches a member renamed or removed, or an argument that changes
 * shape — and NOT a field added on the other side, which this module would drop in silence.
 *
 * MEMBERS ARE FUNCTION-TYPED PROPERTIES, never method syntax: a method's parameter is bivariant, and
 * the assignment in `main.ts` would stop catching an argument that changes shape.
 */

import type { Logger, Timers } from '@factotum/core'

export type Category = 'action' | 'unsubscribe' | 'spam' | 'info'
export type EntryCategory = Category | 'unclassified'
export type Priority = 'high' | 'medium' | 'low'

export interface DigestEntry {
  readonly key: string
  readonly messageId: string | undefined
  readonly account: string
  readonly from: string
  readonly subject: string
  readonly date: string
  readonly link: string | undefined
  readonly category: EntryCategory
  readonly priority?: Priority
  readonly ask?: string
  readonly due?: string
  readonly why?: string
  readonly draft?: string
  readonly unsubscribeHeader: boolean
  readonly attachments: number
  readonly seenLastTime: boolean
}

export interface AccountStatus {
  readonly id: string
  readonly label: string
  readonly state: 'ok' | 'failed'
  readonly reason?: string
  readonly eligible: number
}

export interface RunUsage {
  readonly batches: number
  readonly failedBatches: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  readonly ms: number
  readonly model: string
  readonly effort?: string
}

export type DigestState = 'ok' | 'partial' | 'failed'

export interface Digest {
  readonly id: string
  readonly state: DigestState
  readonly reason?: string
  readonly startedAt: string
  readonly endedAt: string
  readonly window: { readonly since: string; readonly until: string }
  readonly accounts: readonly AccountStatus[]
  readonly entries: readonly DigestEntry[]
  readonly overflow: number
  readonly usage: RunUsage
}

export interface DigestSummary {
  readonly id: string
  readonly state: DigestState
  readonly startedAt: string
  readonly todo: number
  readonly high: number
}

export type Progress =
  | { readonly step: 'reading'; readonly account: number; readonly of: number }
  | { readonly step: 'classifying'; readonly batch: number; readonly of: number }
  | { readonly step: 'saving' }

export interface AccountView {
  readonly id: string
  readonly label: string
  readonly last?: AccountStatus
}

export interface InboxStatus {
  readonly running: boolean
  readonly progress?: Progress
  readonly runId?: string
  readonly accounts: readonly AccountView[]
}

export type RunOutcome = { readonly outcome: 'started'; readonly id: string } | { readonly outcome: 'busy' }

export interface Inbox {
  readonly runNow: () => RunOutcome
  readonly status: () => InboxStatus
  readonly latest: () => Promise<Digest | undefined>
  readonly list: (limit: number) => Promise<readonly DigestSummary[]>
  readonly get: (id: string) => Promise<Digest | undefined>
  readonly stop: () => Promise<void>
}

export interface InboxSetup {
  /** RAW: interpreted on the other side, where the one schema lives (D3). */
  readonly config: unknown
  readonly stateDir: string
  readonly log: Logger
  readonly now: () => Date
  readonly timers: Timers
}

export type CreateInboxResult = { readonly ok: true; readonly inbox: Inbox } | { readonly ok: false; readonly reason: string }

export type CreateInbox = (setup: InboxSetup) => Promise<CreateInboxResult>

/**
 * A COPY of the digest id rule: it is checked HERE, before the other side sees an id from a URL
 * (`GET /digests/:id` answers 400), and that side checks it again before touching the disk.
 */
export const DIGEST_ID = /^\d{4}-\d{2}-\d{2}T\d{4}(-\d+)?$/
