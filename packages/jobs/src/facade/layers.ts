/**
 * The facade's layers (design D3, D13; tasks C1): what `compose` in `jobs.ts` wires, one builder per
 * layer. BUILDING ARMS NO TIMER AND STARTS NO RUN — the lifecycle (`lifecycle.ts`) does, so a builder
 * that throws leaves nothing live.
 *
 * - the checks: the network (https only, private ranges refused, N1), the address checks and the ad walk;
 * - the sends: the password file's health cache, the sender and the assisted paths;
 * - the generation: the CV, rewrite and reprint handlers, the queue with the real linter as its guard (L4),
 *   and the re-lint's hook that queues a reprint (H5c);
 * - the replies (D12): the classifier (the queue's `classify`), its pushes, and the reading task;
 * - the clock (D16), over all of them.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { NotificationMessage } from '@factotum/core'
import { connectImapFlow, sendMail as smtpSend } from '@factotum/mail'

import { createQueue, type JobHandler, type Queue } from '../ai/queue.ts'
import { addressSearch } from '../build/address.ts'
import { createCheckQueue, type CheckQueue } from '../build/checks.ts'
import { createCvHandler, type ClaudeSettings } from '../build/cv.ts'
import type { Linter } from '../build/relint.ts'
import { createReprintHandler } from '../build/reprint.ts'
import { createVerifier } from '../build/verify.ts'
import { createClock, type Clock } from '../clock.ts'
import type { HostConfig } from '../config.ts'
import { createPasswordHealth, type PasswordHealth } from '../mail-health.ts'
import { applyReply, type ApplyDeps } from '../replies/apply.ts'
import { createClassifier, type Classifier } from '../replies/classify.ts'
import { createReplyTask, type ReplyTask } from '../replies/tick.ts'
import { createRewriteHandler } from '../review/rewrite.ts'
import { createNet, systemLookup } from '../scout/net.ts'
import { createAssist } from '../send/assist.ts'
import { createSender } from '../send/send.ts'
import { NO_LETTER_YET } from '../state.ts'
import type { Db } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import type { Profile } from '../types.ts'
import { createAdRevalidator, type AdRevalidator } from './ads.ts'
import { printer, type VaultReader } from './sources.ts'
import type { JobsDeps } from './types.ts'

/** What every layer reads: the store, the seams, the parsed configuration. */
export interface Base {
  readonly db: Db
  readonly deps: JobsDeps
  readonly config: HostConfig
  readonly timeZone: string
}

/** A handler that always fails with `reason`: the `letter` until T1, the CV without its font. */
export const failing =
  (reason: string): JobHandler =>
  async () => ({ ok: false, kind: 'failed', reason })

const claudeOf = (model: string, deps: JobsDeps): ClaudeSettings => ({ model, effort: undefined, bin: deps.claudeBin })

export function buildCheckLayer({ db, deps, config }: Base) {
  const { log, now, timers } = deps
  const net = createNet({ fetch: deps.fetch ?? globalThis.fetch, lookup: deps.lookup ?? systemLookup, timers, now, politeMs: config.scout.politeMs })
  const checks = createCheckQueue({ db, timers, now, search: addressSearch(net), log })
  const enqueueCheck = (contactId: string, options: { readonly front: true }): unknown => checks.enqueueCheck(contactId, options)
  const ads = createAdRevalidator({ db, net, now, log })
  return { net, checks, ads, enqueueCheck }
}

export function buildSendLayer({ db, deps, config, timeZone }: Base, enqueueCheck: (contactId: string, options: { readonly front: true }) => unknown) {
  const { log, now, timers, stateDir } = deps
  // Step 5's cache; every real read refreshes it.
  const password = createPasswordHealth({ file: config.mail.passwordFile, now, ...(deps.lstat === undefined ? {} : { lstat: deps.lstat }), ...(deps.readPassword === undefined ? {} : { readPassword: deps.readPassword }) })
  const sender = createSender({
    db,
    now,
    timers,
    timeZone,
    mail: { address: config.mail.address, displayName: config.mail.displayName, passwordFile: config.mail.passwordFile, smtpHost: config.mail.smtpHost, maxSendsPerDay: config.mail.maxSendsPerDay },
    readPassword: password.readPassword,
    sendMail: deps.sendMail ?? smtpSend,
    enqueueCheck,
    log,
    stateDir,
  })
  const assist = createAssist({ db, now, timeZone, maxSendsPerDay: config.mail.maxSendsPerDay, sender, enqueueCheck })
  return { password, sender, assist }
}

/** What step 3 found on disk that the generation needs. */
export interface OnDisk {
  readonly font: Uint8Array | null
  readonly vault: VaultReader
  readonly linter: Linter
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * D16's push of an interview or an offer, AFTER THE COMMIT: the apply runs inside the queue's `tx`, so
 * the push waits a microtask (the `tx` is synchronous) and goes only if that mail is now seen — the
 * `tx` committed. No device, no push and no retry: the event stays in the tracker.
 */
export function pushAfterCommit({ db, deps }: Base): ApplyDeps['push'] {
  return (key: string, message: NotificationMessage) =>
    queueMicrotask(() => {
      try {
        const notify = deps.notify
        if (notify === undefined || !notify.canReach()) return
        if (!db.read((q) => repo.mailSeen(q, key, null))) return
        void notify.send(message)
      } catch (error) {
        deps.log.error(`jobs replies: a push was not sent (${messageOf(error)})`)
      }
    })
}

export function buildGeneration(base: Base, { font, vault, linter }: OnDisk) {
  const { db, deps, config } = base
  const { log, now, timers, stateDir } = deps
  const printDeps = { stateDir, timers, log, font: font ?? new Uint8Array(), chromium: config.chromium, poppler: config.poppler }
  const verify = createVerifier({ stateDir, now, timers, log, claude: claudeOf(config.claude.models.verify, deps), sources: vault.fixed })
  const print = printer(db, printDeps)
  const cv = font === null ? failing('the CV font could not be read') : createCvHandler({ db, ...printDeps, now, sources: vault.sources, claude: claudeOf(config.claude.models.write, deps), verify })
  const rewrite = createRewriteHandler({
    db,
    now,
    timers,
    stateDir,
    runDir: join(stateDir, 'run'),
    claude: { model: config.claude.models.write, effort: undefined, ...(deps.claudeBin === undefined ? {} : { bin: deps.claudeBin }) },
    readFixed: vault.fixed,
    print,
    verify,
    log,
  })
  // D5 «Reimpresión»: no Claude, so it needs only the printer — and works without the font only as the CV does.
  const reprint = font === null ? failing('the CV font could not be read') : createReprintHandler({ db, print })
  // D12 «Clasificar» on `models.classify`; Q4 applies the verdict in the queue's `tx`.
  const push = pushAfterCommit(base)
  const classifier = createClassifier({
    stateDir,
    now,
    timers,
    log,
    claude: claudeOf(config.claude.models.classify, deps),
    apply: (q, job, verdict, at) => applyReply(q, job, verdict, at, { push }),
  })
  const queue = createQueue({
    db,
    now,
    concurrency: config.claude.concurrency,
    handlers: { cv, rewrite, reprint, letter: failing(NO_LETTER_YET), classify: classifier.handler },
    log,
    lint: linter.lint,
    relintOne: linter.relintOne,
    pdfExists: existsSync,
    classifyFailed: classifier.failed,
  })
  /** The re-lint's hook (D3 «`cv-stale`»): one reprint, in its own `tx`, after the save's. */
  const enqueueReprint = (applicationId: string): void => {
    const added = queue.add({ kind: 'reprint', ref: applicationId })
    if (!added.ok) throw new Error(added.error.reason)
  }
  return { cv, rewrite, queue, enqueueReprint, classifier, push }
}

/** The reading task of the clock (Q5): built, not running; the password read inside it, at every read. */
export function buildReplies({ db, deps, config }: Base, { queue, password, classifier }: { readonly queue: Queue; readonly password: PasswordHealth; readonly classifier: Classifier }): ReplyTask {
  return createReplyTask({
    db,
    now: deps.now,
    timers: deps.timers,
    log: deps.log,
    pollMinutes: config.mail.replyPollMinutes,
    server: { host: config.mail.imapHost, user: config.mail.address },
    passwordFile: config.mail.passwordFile,
    readPassword: password.readPassword,
    connect: deps.connect ?? connectImapFlow,
    classifier,
    enqueue: queue.enqueue,
    pump: queue.pump,
  })
}

/** The clock (D16): built, not armed. */
export function buildClock(
  { db, deps, config, timeZone }: Base,
  { queue, ads, checks, replies }: { readonly queue: Queue; readonly ads: AdRevalidator; readonly checks: CheckQueue; readonly replies: ReplyTask },
): Clock {
  const { log, now, timers, stateDir } = deps
  const profileNow = (): Profile => {
    const current = db.read((q) => repo.latestProfileVersion(q))
    if (current === undefined) throw new Error('jobs: the profile is gone')
    return current.profile
  }
  const seedFiles = (): readonly string[] => config.vault.seed.packages.filter((p) => p.byHand !== true).map((p) => p.file.split('/').at(-1) ?? p.file)
  return createClock({
    db,
    timers,
    now,
    timeZone,
    log,
    stateDir,
    pump: queue.pump,
    prepareTick: () => {
      ads.kick() // D9 «El anuncio vivo», in the background (crit. 24, 46b)
      return checks.prepareTick({ batchSize: profileNow().batchSize })
    },
    enqueueCv: queue.enqueueCv,
    seedFiles,
    replies: replies.run,
  })
}
