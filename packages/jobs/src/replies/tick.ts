/**
 * The replies task of the clock (design D16 «Respuestas», D12; tasks Q5; requirements crit. 57).
 *
 * WHEN: every round of the clock asks; it reads once `now − lastReplyPoll ≥ replyPollMinutes` (or
 * never read). ALSO DURING AN ABSENCE: nothing here looks at the profile's absences — only the
 * follow-ups pause (F). A read that fails leaves `lastReplyPoll` where it was, so the next round (60 s)
 * tries again; after `READ_FAILURES_FLAG` failures in a row, `meta.replyReadFailing` holds when the
 * first of them happened (for `health()`: «Mail reading failing since <hora>»), and the next good read
 * clears it. A stop is not a failure.
 *
 * THE PASSWORD is read from its file HERE, at every read, as the sender does (`readPassword`) — never
 * at start, never logged; the reader masks it (and the user) out of any reason.
 *
 * WHAT A READ HANDS OVER is written IN THE READ'S OWN `tx` (`readReplies`' `handle`), with the poll:
 * an unmatched mail (rule 4) becomes an «Unmatched reply»; a matched one goes to classification (the
 * classifier keeps its body in memory) and HOLDS the window at its INTERNALDATE until no classification
 * waits any more — so a classification that outlives its body (a restart after a long pause) is found
 * again by the next read (the pending item of Q1). The hold is released only by a read that left NO
 * mail to a pending work and finds none pending in its `tx`: a work that ended between the two (a
 * restart, nothing applied) keeps it for one more read, which finds the mail again. The queue is
 * pumped after the `tx`.
 *
 * NOTHING HERE LOGS a body, a subject or an address: only counts and the masked reason.
 */

import type { Logger, Timers } from '@factotum/core'
import type { ConnectImap, PasswordResult } from '@factotum/mail'

import type { Queue } from '../ai/queue.ts'
import type { Db, Queries } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { ok, type Result } from '../types.ts'
import { recordUnmatched } from './apply.ts'
import { classifyInputOf, type Classifier } from './classify.ts'
import { readReplies, type ReadReply } from './read.ts'

/** After this many failed reads in a row, `health()` says so (crit. 57). */
export const READ_FAILURES_FLAG = 3
/** `meta` key: the ISO instant the failing streak started; absent while reading works. */
export const REPLY_READ_FAILING = 'replyReadFailing'

const MINUTE_MS = 60_000

export interface ReplyTaskDeps {
  readonly db: Db
  readonly now: () => Date
  /** The kernel's: the read's cap. */
  readonly timers: Timers
  readonly log: Logger
  /** `mail.replyPollMinutes`. */
  readonly pollMinutes: number
  /** `mail.imapHost` and `mail.address`. */
  readonly server: { readonly host: string; readonly user: string }
  readonly passwordFile: string
  /** The password health's `readPassword` (it refreshes the cache). */
  readonly readPassword: (file: string) => Promise<PasswordResult>
  readonly connect: ConnectImap
  readonly classifier: Pick<Classifier, 'submit'>
  readonly enqueue: Queue['enqueue']
  readonly pump: () => void
  /** A test cannot wait the reader's ninety seconds. */
  readonly timeoutMs?: number
}

export interface ReplyTask {
  /** One round's turn: reads if due. Never throws. */
  readonly run: () => Promise<void>
  /** Aborts a read under way; later rounds read nothing. */
  readonly stop: () => void
}

export function createReplyTask(deps: ReplyTaskDeps): ReplyTask {
  const { db, now, log } = deps
  const stopping = new AbortController()
  let failures = 0
  let failingSince: string | null = null

  const due = (at: Date): boolean => {
    const last = db.read((q) => repo.getMeta(q, repo.LAST_REPLY_POLL))
    return last === undefined || at.getTime() - Date.parse(last) >= deps.pollMinutes * MINUTE_MS
  }

  /** In the read's `tx`: the unmatched recorded, the matched submitted and held. */
  const handle = (q: Queries, replies: readonly ReadReply[], pollAt: Date, waiting: number): Result<void> => {
    if (waiting === 0 && repo.pendingClassifyRefs(q).size === 0) repo.releaseHold(q)
    for (const reply of replies) {
      const input = reply.match.kind === 'unmatched' ? undefined : classifyInputOf(q, reply)
      if (input === undefined || input.candidates.length === 0) {
        const recorded = recordUnmatched(q, reply, pollAt)
        if (!recorded.ok) return recorded
        continue
      }
      const submitted = deps.classifier.submit(q, deps.enqueue, { reply, input })
      if (!submitted.ok) return submitted
      repo.holdReplies(q, reply.receivedAt)
    }
    return ok(undefined)
  }

  const remember = (write: (q: Queries) => void): void => {
    const written = db.tx((q) => ok(write(q)))
    if (!written.ok) log.error(`jobs replies: ${REPLY_READ_FAILING} was not written (${written.error.reason})`)
  }

  function failed(reason: string, at: Date): void {
    failures += 1
    failingSince ??= at.toISOString()
    log.warn(`jobs replies: the mailbox could not be read (${reason}); the next round tries again`)
    const since = failingSince
    if (failures >= READ_FAILURES_FLAG && db.read((q) => repo.getMeta(q, REPLY_READ_FAILING)) === undefined) {
      log.error(`jobs replies: the mailbox has failed ${failures} reads in a row`)
      remember((q) => repo.setMeta(q, REPLY_READ_FAILING, since))
    }
  }

  function worked(): void {
    failures = 0
    failingSince = null
    if (db.read((q) => repo.getMeta(q, REPLY_READ_FAILING)) !== undefined) remember((q) => repo.deleteMeta(q, REPLY_READ_FAILING))
  }

  async function read(at: Date): Promise<void> {
    const password = await deps.readPassword(deps.passwordFile)
    if (stopping.signal.aborted) return
    if (!password.ok) return failed(password.reason, at)
    const result = await readReplies({
      db,
      server: deps.server,
      password: password.password,
      connect: deps.connect,
      timers: deps.timers,
      signal: stopping.signal,
      now,
      handle,
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    })
    if (stopping.signal.aborted) return
    if (!result.ok) return failed(result.reason, at)
    worked()
    deps.pump()
  }

  return {
    run: async () => {
      const at = now()
      if (stopping.signal.aborted || !due(at)) return
      try {
        await read(at)
      } catch (error) {
        failed(error instanceof Error ? error.constructor.name : 'error', at)
      }
    },
    stop: () => stopping.abort(),
  }
}
