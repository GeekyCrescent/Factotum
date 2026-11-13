/**
 * The facade's layers (design D3, D13; tasks C1): what `compose` in `jobs.ts` wires, one builder per
 * layer. BUILDING ARMS NO TIMER AND STARTS NO RUN — the lifecycle (`lifecycle.ts`) does, so a builder
 * that throws leaves nothing live.
 *
 * - the checks: the network (https only, private ranges refused, N1), the address checks and the ad walk;
 * - the sends: the password file's health cache, the sender and the assisted paths;
 * - the generation: the CV and rewrite handlers, the queue with the real linter as its guard (L4);
 * - the clock (D16), over all three.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { sendMail as smtpSend } from '@factotum/mail'

import { createQueue, type JobHandler, type Queue } from '../ai/queue.ts'
import { addressSearch } from '../build/address.ts'
import { createCheckQueue, type CheckQueue } from '../build/checks.ts'
import { createCvHandler, type ClaudeSettings } from '../build/cv.ts'
import type { Linter } from '../build/relint.ts'
import { createVerifier } from '../build/verify.ts'
import { createClock, type Clock } from '../clock.ts'
import type { HostConfig } from '../config.ts'
import { createPasswordHealth } from '../mail-health.ts'
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

export function buildGeneration({ db, deps, config }: Base, { font, vault, linter }: OnDisk) {
  const { log, now, timers, stateDir } = deps
  const printDeps = { stateDir, timers, log, font: font ?? new Uint8Array(), chromium: config.chromium, poppler: config.poppler }
  const verify = createVerifier({ stateDir, now, timers, log, claude: claudeOf(config.claude.models.verify, deps), sources: vault.fixed })
  const cv = font === null ? failing('the CV font could not be read') : createCvHandler({ db, ...printDeps, now, sources: vault.sources, claude: claudeOf(config.claude.models.write, deps), verify })
  const rewrite = createRewriteHandler({
    db,
    now,
    timers,
    stateDir,
    runDir: join(stateDir, 'run'),
    claude: { model: config.claude.models.write, effort: undefined, ...(deps.claudeBin === undefined ? {} : { bin: deps.claudeBin }) },
    readFixed: vault.fixed,
    print: printer(db, printDeps),
    verify,
    log,
  })
  const queue = createQueue({
    db,
    now,
    concurrency: config.claude.concurrency,
    handlers: { cv, rewrite, letter: failing(NO_LETTER_YET) },
    log,
    lint: linter.lint,
    relintOne: linter.relintOne,
    pdfExists: existsSync,
  })
  return { cv, rewrite, queue }
}

/** The clock (D16): built, not armed. */
export function buildClock({ db, deps, config, timeZone }: Base, { queue, ads, checks }: { readonly queue: Queue; readonly ads: AdRevalidator; readonly checks: CheckQueue }): Clock {
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
  })
}
