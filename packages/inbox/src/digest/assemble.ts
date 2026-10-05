/**
 * Mails and verdicts → one Digest (spec 2026-10-05, D7). Pure.
 *
 * THE BODY HAS NOWHERE TO GO: `DigestEntry` has no field for it, and every entry is built field by
 * field below — never by spreading a `FetchedMail` (criterion 22).
 *
 * The order the screen shows (criterion 13) and the grouping of unsubscribes (criterion 15) are NOT
 * made here: the file keeps entries in arrival order, and the client's `model.ts` sorts them, so the
 * order can change without migrating a file.
 */

import type { AccountConfig, InboxConfig } from '../config.ts'
import type { FetchedMail } from '../mail/fetch.ts'
import type { Verdict } from '../classify/schema.ts'
import type { AccountStatus, Digest, DigestEntry, DigestState, RunUsage } from '../types.ts'

export type AccountOutcome =
  | { readonly account: AccountConfig; readonly ok: true; readonly mails: readonly FetchedMail[] }
  | { readonly account: AccountConfig; readonly ok: false; readonly reason: string }

export interface BatchTally {
  readonly total: number
  readonly failed: number
  /** The first failure, for the digest's reason. */
  readonly firstReason: string | undefined
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  /** The model the CLI reported, when a batch reported one. */
  readonly model: string | undefined
}

export interface AssembleInput {
  readonly id: string
  readonly startedAt: Date
  readonly endedAt: Date
  readonly since: Date
  readonly config: InboxConfig
  readonly accounts: readonly AccountOutcome[]
  /** What was sent to classification, newest first: at most MAX_PER_RUN. */
  readonly classified: readonly FetchedMail[]
  readonly overflow: number
  /** By entry key (`keyOf`). A mail without one is `unclassified` (criterion 12). */
  readonly verdicts: ReadonlyMap<string, Verdict>
  readonly batches: BatchTally
  /** Set when the run's cap expired (criterion 20). */
  readonly timedOut: string | undefined
  readonly previous: Digest | undefined
}

export function keyOf(mail: Pick<FetchedMail, 'accountId' | 'uid'>): string {
  return `${mail.accountId}:${mail.uid}`
}

export function assemble(input: AssembleInput): Digest {
  const seenBefore = new Set(
    (input.previous?.entries ?? []).flatMap((entry) => (entry.messageId === undefined ? [] : [entry.messageId])),
  )
  const accountById = new Map(input.config.accounts.map((account) => [account.id, account]))
  const entries = input.classified.map((mail) =>
    entryOf(mail, input.verdicts.get(keyOf(mail)), accountById.get(mail.accountId), seenBefore),
  )
  const accounts: AccountStatus[] = input.accounts.map((outcome) =>
    outcome.ok
      ? { id: outcome.account.id, label: outcome.account.label, state: 'ok', eligible: outcome.mails.length }
      : { id: outcome.account.id, label: outcome.account.label, state: 'failed', reason: outcome.reason, eligible: 0 },
  )
  const { state, reason } = stateOf(input, entries)
  const usage: RunUsage = {
    batches: input.batches.total,
    failedBatches: input.batches.failed,
    inputTokens: input.batches.inputTokens,
    outputTokens: input.batches.outputTokens,
    costUsd: input.batches.costUsd,
    ms: input.endedAt.getTime() - input.startedAt.getTime(),
    model: input.batches.model ?? input.config.model,
    ...(input.config.effort === undefined ? {} : { effort: input.config.effort }),
  }
  return {
    id: input.id,
    state,
    ...(reason === undefined ? {} : { reason }),
    startedAt: input.startedAt.toISOString(),
    endedAt: input.endedAt.toISOString(),
    window: { since: input.since.toISOString(), until: input.startedAt.toISOString() },
    accounts,
    entries,
    overflow: input.overflow,
    usage,
  }
}

function entryOf(
  mail: FetchedMail,
  verdict: Verdict | undefined,
  account: AccountConfig | undefined,
  seenBefore: ReadonlySet<string>,
): DigestEntry {
  const source = account?.sources.find((candidate) => candidate.id === mail.sourceId)
  const hex = gmailHex(mail.gmailId)
  return {
    key: keyOf(mail),
    messageId: mail.messageId,
    account: source?.label ?? account?.label ?? mail.accountId,
    from: mail.from,
    subject: mail.subject,
    date: mail.date,
    link: hex === undefined || account === undefined ? undefined : `https://mail.google.com/mail/u/${encodeURIComponent(account.user)}/#all/${hex}`,
    category: verdict?.category ?? 'unclassified',
    ...(verdict?.priority === undefined ? {} : { priority: verdict.priority }),
    ...(verdict?.ask === undefined ? {} : { ask: verdict.ask }),
    ...(verdict?.due === undefined ? {} : { due: verdict.due }),
    ...(verdict?.why === undefined ? {} : { why: verdict.why }),
    ...(verdict?.draft === undefined ? {} : { draft: verdict.draft }),
    unsubscribeHeader: mail.unsubscribe,
    attachments: mail.attachments,
    seenLastTime: mail.messageId !== undefined && seenBefore.has(mail.messageId),
  }
}

/**
 * `ok`: every account and every batch went well. `partial`: something failed and something came out.
 * `failed`: nothing came out — every account failed, or there was mail and none of it was classified.
 */
function stateOf(input: AssembleInput, entries: readonly DigestEntry[]): { state: DigestState; reason: string | undefined } {
  const failedAccounts = input.accounts.filter((outcome) => !outcome.ok).length
  const classified = entries.filter((entry) => entry.category !== 'unclassified').length
  const reasons = [
    input.timedOut,
    input.batches.failed === 0 ? undefined : `${input.batches.failed} of ${input.batches.total} batches failed: ${input.batches.firstReason ?? 'unknown'}`,
    failedAccounts === 0 ? undefined : `${failedAccounts} of ${input.accounts.length} accounts failed`,
  ].filter((part): part is string => part !== undefined)
  const reason = reasons.length === 0 ? undefined : reasons.join('; ')

  if (input.accounts.length > 0 && failedAccounts === input.accounts.length) return { state: 'failed', reason }
  if (entries.length > 0 && classified === 0) return { state: 'failed', reason: reason ?? 'nothing was classified' }
  if (reason !== undefined) return { state: 'partial', reason }
  return { state: 'ok', reason: undefined }
}

/** Gmail's web UI wants X-GM-MSGID in hex. */
export function gmailHex(gmailId: string | undefined): string | undefined {
  if (gmailId === undefined || !/^\d+$/.test(gmailId)) return undefined
  return BigInt(gmailId).toString(16)
}
