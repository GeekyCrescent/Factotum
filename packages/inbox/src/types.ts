/**
 * The shapes of the mail digest (spec 2026-10-05-bandeja-resumida, design D2, D7).
 *
 * `modules/inbox/types.ts` declares these AGAIN, by hand: a module cannot import this package
 * (CLAUDE.md §1). The two meet at one assignment in `packages/cli/src/main.ts`, where the compiler
 * checks that the factory fits — the same arrangement as the session engine.
 */

import type { Logger, Timers } from '@factotum/core'
import type { ConnectImap } from './mail/client.ts'

export type Category = 'action' | 'unsubscribe' | 'spam' | 'info'
export type EntryCategory = Category | 'unclassified'
export type Priority = 'high' | 'medium' | 'low'

/** One mail as the digest keeps it. NO BODY: the type has nowhere to put one (criterion 22). */
export interface DigestEntry {
  /** `<accountId>:<uid>` — unique within one run. */
  readonly key: string
  readonly messageId: string | undefined
  /** The label of the source the mail came through, or of the account. */
  readonly account: string
  readonly from: string
  readonly subject: string
  readonly date: string
  /** `https://mail.google.com/mail/u/<user>/#all/<X-GM-MSGID in hex>`, when the server gave one. */
  readonly link: string | undefined
  readonly category: EntryCategory
  readonly priority?: Priority
  readonly ask?: string
  readonly due?: string
  readonly why?: string
  readonly draft?: string
  readonly unsubscribeHeader: boolean
  readonly attachments: number
  /** Its Message-ID was among the entries of the previous run (criterion 25). */
  readonly seenLastTime: boolean
}

export interface AccountStatus {
  readonly id: string
  readonly label: string
  readonly state: 'ok' | 'failed'
  readonly reason?: string
  /** How many of its mails were eligible this run. */
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
  /** Local start time, `YYYY-MM-DDTHHmm`, with `-2`… when two runs share a minute. */
  readonly id: string
  readonly state: DigestState
  readonly reason?: string
  readonly startedAt: string
  readonly endedAt: string
  readonly window: { readonly since: string; readonly until: string }
  readonly accounts: readonly AccountStatus[]
  readonly entries: readonly DigestEntry[]
  /** Eligible mails left out past MAX_PER_RUN (criterion 16). */
  readonly overflow: number
  readonly usage: RunUsage
}

/** One line of the history. */
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

/** A configured account and, after the first run, how it went last time (criterion 2). */
export interface AccountView {
  readonly id: string
  readonly label: string
  readonly last?: AccountStatus
}

export interface InboxStatus {
  readonly running: boolean
  /** Only while running. */
  readonly progress?: Progress
  /** The id of the run in flight, or of the last one this process made. */
  readonly runId?: string
  readonly accounts: readonly AccountView[]
}

export type RunOutcome = { readonly outcome: 'started'; readonly id: string } | { readonly outcome: 'busy' }

export interface Inbox {
  /** Synchronous reservation: `busy` while another runs (criterion 19). The run goes on in the background. */
  readonly runNow: () => RunOutcome
  /** Running or not, where it is (criterion 18), and each account's last state (criterion 2). */
  readonly status: () => InboxStatus
  readonly latest: () => Promise<Digest | undefined>
  readonly list: (limit: number) => Promise<readonly DigestSummary[]>
  readonly get: (id: string) => Promise<Digest | undefined>
  /** Kills claude, closes IMAP, waits for the run to end. Never throws. */
  readonly stop: () => Promise<void>
}

export interface InboxDeps {
  /** RAW: the module carries it as `z.unknown()` and cannot parse it — the schema lives here (D3). */
  readonly config: unknown
  readonly stateDir: string
  readonly log: Logger
  readonly now: () => Date
  readonly timers: Timers
  /** The seam for `fake-claude`. Never from the configuration. */
  readonly bin?: string
  /** The seam for the IMAP client double, or a real ImapFlow with a test CA. */
  readonly connect?: ConnectImap
}

export type CreateInboxResult = { readonly ok: true; readonly inbox: Inbox } | { readonly ok: false; readonly reason: string }

export type CreateInbox = (deps: InboxDeps) => Promise<CreateInboxResult>
