/**
 * The facade: one run at a time, in the background, always ending in a file and a log line
 * (spec 2026-10-05, D2).
 *
 * `runNow` RESERVES SYNCHRONOUSLY — a boolean in memory — so two presses never start two runs
 * (criterion 19), and returns at once: the run goes on after `POST /run` has answered (criterion 17).
 *
 * THE CAP. A whole run lives inside one AbortController, armed with RUN_TIMEOUT_MS on the kernel's
 * timers. When it fires, claude's group is killed and IMAP is closed — and assembling and saving
 * STILL RUN with the verdicts there are: the quota already spent is not thrown away (criterion 20).
 *
 * NOTHING THROWS OUT OF A RUN, and its log lines carry counts, tokens, cost and time — never a
 * sender, a subject or a body (criterion 27).
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { classifyBatch } from './classify/run.ts'
import type { PromptMail } from './classify/prompt.ts'
import type { Verdict } from './classify/schema.ts'
import { parseInboxConfig, type InboxConfig } from './config.ts'
import { assemble, keyOf, type AccountOutcome, type BatchTally } from './digest/assemble.ts'
import { openDigestStore, type DigestStore } from './digest/store.ts'
import { connectImapFlow } from './mail/client.ts'
import { fetchAccount, type FetchedMail } from './mail/fetch.ts'
import { readPassword } from './secrets.ts'
import type { AccountStatus, AccountView, CreateInboxResult, Inbox, InboxDeps, InboxStatus, Progress } from './types.ts'

/** Measured budget (tasks §M, A6): accounts × 90 s + ceil(400 / 40) × 38 s fits under this. */
export const RUN_TIMEOUT_MS = 15 * 60_000
/** A batch of 40 × 4 000 characters is ~160 KB and took 26–38 s in A2. */
export const BATCH_SIZE = 40
/** The newest this many eligible mails are classified; the rest are counted as overflow (criterion 16). */
export const MAX_PER_RUN = 400

const HOUR_MS = 60 * 60 * 1000

/** A seam for tests only: every step, as it starts. */
export type ProgressHook = (progress: Progress) => void

interface Running {
  readonly id: string
  readonly controller: AbortController
  progress: Progress
  timedOut: boolean
  done: Promise<void>
}

export async function createInbox(deps: InboxDeps & { readonly onProgress?: ProgressHook }): Promise<CreateInboxResult> {
  const parsed = parseInboxConfig(deps.config)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const config = parsed.config
  const runDir = join(deps.stateDir, 'run')
  const digestsDir = join(deps.stateDir, 'digests')

  let store: DigestStore
  let lastAccounts: readonly AccountStatus[] | undefined
  try {
    // Without these, the first spawn fails with ENOENT for its cwd.
    await mkdir(runDir, { recursive: true })
    await mkdir(digestsDir, { recursive: true })
    store = await openDigestStore(digestsDir, deps.log)
    const pruned = await store.prune(config.keepDays, deps.now())
    if (pruned > 0) deps.log.info(`pruned ${pruned} digest${pruned === 1 ? '' : 's'} older than ${config.keepDays} days`)
    lastAccounts = (await store.latest())?.accounts
  } catch (error) {
    return { ok: false, reason: `the inbox state could not be prepared (${codeOf(error)})` }
  }

  let running: Running | undefined
  let lastRunId: string | undefined
  let stopped = false

  const setProgress = (run: Running, progress: Progress): void => {
    run.progress = progress
    deps.onProgress?.(progress)
  }

  const execute = async (run: Running, startedAt: Date): Promise<void> => {
    const signal = run.controller.signal
    const since = new Date(startedAt.getTime() - config.windowHours * HOUR_MS)
    const previous = await store.latest()

    const accounts = await readAccounts(config, deps, since, signal, (index) =>
      setProgress(run, { step: 'reading', account: index + 1, of: config.accounts.length }),
    )
    const all = accounts
      .flatMap((outcome) => (outcome.ok ? outcome.mails : []))
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    const classified = all.slice(0, MAX_PER_RUN)

    const { verdicts, tally } = await classifyAll(config, deps, classified, startedAt, runDir, signal, (batch, of) =>
      setProgress(run, { step: 'classifying', batch, of }),
    )

    setProgress(run, { step: 'saving' })
    const digest = assemble({
      id: run.id,
      startedAt,
      endedAt: deps.now(),
      since,
      config,
      accounts,
      classified,
      overflow: all.length - classified.length,
      verdicts,
      batches: tally,
      timedOut: run.timedOut ? `timed out after ${Math.round(RUN_TIMEOUT_MS / 60_000)} min` : stopped ? 'stopped' : undefined,
      previous,
    })
    await store.write(digest)
    lastAccounts = digest.accounts
    await store.prune(config.keepDays, deps.now())

    // Criterion 27: counts, tokens, cost and time. Never a sender, a subject or a body.
    const perAccount = digest.accounts.map((account) => `${account.id} ${account.state === 'ok' ? `${account.eligible} mails` : 'failed'}`)
    deps.log.info(
      `run ${run.id} ${digest.state}: ${perAccount.join(', ')}; ${tally.total} batches (${tally.failed} failed); ` +
        `${tally.inputTokens} tokens in, ${tally.outputTokens} out; $${tally.costUsd.toFixed(3)}; ${Math.round(digest.usage.ms / 1000)} s`,
    )
    for (const account of digest.accounts) {
      if (account.state === 'failed') deps.log.warn(`run ${run.id}: account ${account.id} failed: ${account.reason ?? 'unknown'}`)
    }
    if (tally.failed > 0) deps.log.warn(`run ${run.id}: ${tally.failed} of ${tally.total} batches failed: ${tally.firstReason ?? 'unknown'}`)
  }

  const inbox: Inbox = {
    runNow: () => {
      if (running !== undefined || stopped) return { outcome: 'busy' }
      const startedAt = deps.now()
      const id = store.nextId(startedAt)
      const run: Running = {
        id,
        controller: new AbortController(),
        progress: { step: 'reading', account: 0, of: config.accounts.length },
        timedOut: false,
        done: Promise.resolve(),
      }
      const cap = deps.timers.setTimeout(() => {
        run.timedOut = true
        run.controller.abort()
      }, RUN_TIMEOUT_MS)
      running = run
      lastRunId = id
      deps.log.info(`run ${id} started`)
      run.done = execute(run, startedAt)
        .catch((error: unknown) => deps.log.error(`run ${id} could not finish: ${codeOf(error)}`))
        .finally(() => {
          cap[Symbol.dispose]()
          running = undefined
        })
      return { outcome: 'started', id }
    },

    status: () => {
      const views: AccountView[] = config.accounts.map((account) => {
        const last = lastAccounts?.find((status) => status.id === account.id)
        return last === undefined ? { id: account.id, label: account.label } : { id: account.id, label: account.label, last }
      })
      const runId = running?.id ?? lastRunId
      const status: InboxStatus = {
        running: running !== undefined,
        ...(running === undefined ? {} : { progress: running.progress }),
        ...(runId === undefined ? {} : { runId }),
        accounts: views,
      }
      return status
    },

    latest: () => store.latest(),
    list: (limit) => store.list(limit),
    get: (id) => store.get(id),

    stop: async () => {
      try {
        stopped = true
        const run = running
        if (run === undefined) return
        run.controller.abort()
        await run.done
      } catch (error) {
        deps.log.warn(`inbox did not stop cleanly: ${codeOf(error)}`)
      }
    },
  }
  return { ok: true, inbox }
}

/** One account after the other; one that fails is written down and the rest go on (criterion 9). */
async function readAccounts(
  config: InboxConfig,
  deps: InboxDeps,
  since: Date,
  signal: AbortSignal,
  onAccount: (index: number) => void,
): Promise<readonly AccountOutcome[]> {
  const outcomes: AccountOutcome[] = []
  for (const [index, account] of config.accounts.entries()) {
    onAccount(index)
    // Read at every run, never at startup: rotating the password asks for no restart (D3).
    const password = await readPassword(account.passwordFile)
    if (!password.ok) {
      outcomes.push({ account, ok: false, reason: password.reason })
      continue
    }
    const result = await fetchAccount({
      account,
      password: password.password,
      since,
      signal,
      connect: deps.connect ?? connectImapFlow,
      timers: deps.timers,
      maxBodies: MAX_PER_RUN,
    })
    outcomes.push(result.ok ? { account, ok: true, mails: result.mails } : { account, ok: false, reason: result.reason })
  }
  return outcomes
}

/** Batch after batch. A batch that fails, or is never run because the cap expired, leaves its mails unclassified. */
async function classifyAll(
  config: InboxConfig,
  deps: InboxDeps,
  mails: readonly FetchedMail[],
  startedAt: Date,
  cwd: string,
  signal: AbortSignal,
  onBatch: (batch: number, of: number) => void,
): Promise<{ verdicts: ReadonlyMap<string, Verdict>; tally: BatchTally }> {
  const batches: FetchedMail[][] = []
  for (let start = 0; start < mails.length; start += BATCH_SIZE) batches.push(mails.slice(start, start + BATCH_SIZE))
  const accountLabels = new Map(config.accounts.map((account) => [account.id, account]))
  const verdicts = new Map<string, Verdict>()
  let tally: BatchTally = { total: batches.length, failed: 0, firstReason: undefined, inputTokens: 0, outputTokens: 0, costUsd: 0, model: undefined }

  for (const [index, batch] of batches.entries()) {
    onBatch(index + 1, batches.length)
    const keys = new Map<string, string>()
    const prompt: PromptMail[] = batch.map((mail, position) => {
      const id = `b${position}`
      keys.set(id, keyOf(mail))
      const account = accountLabels.get(mail.accountId)
      const source = account?.sources.find((candidate) => candidate.id === mail.sourceId)
      return {
        id,
        account: source?.label ?? account?.label ?? mail.accountId,
        from: mail.from,
        date: mail.date,
        subject: mail.subject,
        body: mail.body,
        unsubscribe: mail.unsubscribe,
        attachments: mail.attachments,
      }
    })
    const result = await classifyBatch({
      mails: prompt,
      today: localDay(startedAt),
      model: config.model,
      effort: config.effort,
      cwd,
      signal,
      timers: deps.timers,
      ...(deps.bin === undefined ? {} : { bin: deps.bin }),
    })
    if (!result.ok) {
      tally = { ...tally, failed: tally.failed + 1, firstReason: tally.firstReason ?? result.reason }
      continue
    }
    for (const [id, verdict] of result.verdicts) {
      const key = keys.get(id)
      if (key !== undefined) verdicts.set(key, verdict)
    }
    tally = {
      ...tally,
      inputTokens: tally.inputTokens + result.usage.inputTokens,
      outputTokens: tally.outputTokens + result.usage.outputTokens,
      costUsd: tally.costUsd + result.usage.costUsd,
      model: tally.model ?? result.usage.model,
    }
  }
  return { verdicts, tally }
}

/** The owner's day, not UTC's: in Sydney, UTC is still yesterday every morning. */
function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  return error instanceof Error ? error.message : String(error)
}
